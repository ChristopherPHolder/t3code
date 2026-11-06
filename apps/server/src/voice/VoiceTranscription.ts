import {
  VoiceModelDownloadError,
  type VoiceAvailability,
  type VoiceStatusResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import {
  buildWhisperArgs,
  installHintForPlatform,
  isSafeModelName,
  modelDownloadBytes,
  modelDownloadUrl,
  parseWhisperTranscript,
  resolveModelName,
  WHISPER_BINARY_CANDIDATES,
} from "./whisperCli.ts";

export interface VoiceTranscribeFailure {
  readonly status: number;
  readonly detail: string;
}

export type VoiceTranscribeResult = { readonly text: string } | VoiceTranscribeFailure;

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly status: Effect.Effect<VoiceStatusResult>;
    readonly prepareModel: Effect.Effect<VoiceStatusResult, VoiceModelDownloadError>;
    readonly transcribe: (audio: Uint8Array) => Effect.Effect<VoiceTranscribeResult>;
  }
>()("t3/voice/VoiceTranscription") {}

/** A short recording transcribes in well under this even on a slow CPU; a hang must not pin a request. */
const TRANSCRIBE_TIMEOUT = "120 seconds";
const MODEL_DOWNLOAD_TIMEOUT = "15 minutes";

const make = Effect.fn("VoiceTranscription.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const httpClient = yield* HttpClient.HttpClient;

  const modelName = resolveModelName(environment.T3CODE_WHISPER_MODEL_NAME);
  const modelsDir = path.join(config.baseDir, "caches", "voice-models");
  const configuredModelPath = environment.T3CODE_WHISPER_MODEL?.trim();
  const modelPath =
    configuredModelPath && configuredModelPath.length > 0
      ? configuredModelPath
      : path.join(modelsDir, modelName);

  const resolveBinary = Effect.fn("VoiceTranscription.resolveBinary")(function* () {
    const configured = environment.T3CODE_WHISPER_BIN?.trim();
    if (configured && configured.length > 0) return configured;
    for (const candidate of WHISPER_BINARY_CANDIDATES) {
      const resolved = yield* resolveCommandPath(candidate, { env: environment }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (resolved !== null) return resolved;
    }
    return null;
  });

  const modelExists = fileSystem.exists(modelPath).pipe(Effect.orElseSucceed(() => false));

  const availability = Effect.fn("VoiceTranscription.availability")(function* () {
    const binary = yield* resolveBinary();
    if (binary === null) {
      return {
        _tag: "binary-missing",
        installHint: installHintForPlatform(platform),
      } satisfies VoiceAvailability;
    }
    return (yield* modelExists)
      ? ({ _tag: "ready", modelName } satisfies VoiceAvailability)
      : ({
          _tag: "model-missing",
          modelName,
          downloadBytes: modelDownloadBytes(modelName),
        } satisfies VoiceAvailability);
  });

  const downloadFailed = (detail: string) => new VoiceModelDownloadError({ modelName, detail });

  const downloadModel = Effect.fn("VoiceTranscription.downloadModel")(function* () {
    if (!isSafeModelName(modelName)) {
      return yield* downloadFailed("Unsupported model name.");
    }

    yield* fileSystem
      .makeDirectory(modelsDir, { recursive: true })
      .pipe(Effect.catch((cause) => downloadFailed(`Could not create ${modelsDir}: ${cause}`)));
    // Download beside the target so a cancelled or failed transfer never leaves a truncated model
    // that later looks present to `availability`.
    const partialPath = `${modelPath}.part`;
    const response = yield* httpClient
      .execute(HttpClientRequest.get(modelDownloadUrl(modelName)))
      .pipe(Effect.catch((cause) => downloadFailed(String(cause))));
    if (response.status !== 200) {
      return yield* downloadFailed(`The model host answered ${response.status}.`);
    }
    yield* response.stream.pipe(
      Stream.run(fileSystem.sink(partialPath)),
      Effect.catch((cause) => downloadFailed(String(cause))),
    );
    yield* fileSystem
      .rename(partialPath, modelPath)
      .pipe(Effect.catch((cause) => downloadFailed(`Could not store the model: ${cause}`)));
    yield* Effect.logInfo("Downloaded the speech model.", { modelName });
  });

  const runWhisper = Effect.fn("VoiceTranscription.runWhisper")(function* (
    binary: string,
    audioPath: string,
  ) {
    const outcome = yield* Effect.result(
      processRunner.run({
        command: binary,
        args: [...buildWhisperArgs({ modelPath, audioPath, modelName })],
        timeout: TRANSCRIBE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      }),
    );
    if (Result.isFailure(outcome)) {
      yield* Effect.logError("Speech recognition failed to run.", { cause: outcome.failure });
      return {
        status: 500,
        detail: "Speech recognition could not start.",
      } satisfies VoiceTranscribeResult;
    }
    const run = outcome.success;
    if (run.timedOut) {
      return {
        status: 504,
        detail: "Speech recognition timed out.",
      } satisfies VoiceTranscribeResult;
    }
    if (run.code !== 0) {
      yield* Effect.logError("Speech recognition exited with an error.", {
        code: run.code,
        stderr: run.stderr.slice(-2000),
      });
      return { status: 500, detail: "Speech recognition failed." } satisfies VoiceTranscribeResult;
    }
    return { text: parseWhisperTranscript(run.stdout) } satisfies VoiceTranscribeResult;
  });

  const transcribe = Effect.fn("VoiceTranscription.transcribe")(function* (audio: Uint8Array) {
    const binary = yield* resolveBinary();
    if (binary === null) {
      return {
        status: 503,
        detail: `Speech recognition is not installed. Run: ${installHintForPlatform(platform)}`,
      } satisfies VoiceTranscribeResult;
    }
    if (!(yield* modelExists)) {
      return {
        status: 503,
        detail: `The speech model ${modelName} is not downloaded yet.`,
      } satisfies VoiceTranscribeResult;
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-" });
        const audioPath = path.join(directory, "dictation.wav");
        yield* fileSystem.writeFile(audioPath, audio);
        return yield* runWhisper(binary, audioPath);
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logError("Could not stage the dictation audio.", { cause }).pipe(
          Effect.as({
            status: 500,
            detail: "Could not read the recording.",
          } satisfies VoiceTranscribeResult),
        ),
      ),
    );
  });

  return VoiceTranscription.of({
    status: availability().pipe(Effect.map((value) => ({ availability: value }))),
    prepareModel: Effect.gen(function* () {
      const current = yield* availability();
      if (current._tag !== "model-missing") return { availability: current };
      yield* downloadModel().pipe(
        Effect.timeoutOrElse({
          duration: MODEL_DOWNLOAD_TIMEOUT,
          orElse: () => Effect.fail(downloadFailed("The download timed out.")),
        }),
      );
      return { availability: yield* availability() };
    }),
    transcribe,
  });
});

export const layer = Layer.effect(VoiceTranscription, make());
