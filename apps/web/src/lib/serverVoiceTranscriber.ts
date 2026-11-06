import type { EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";
import { voiceEnvironment } from "../state/voice";
import { recordingToWav } from "./voiceDictationAudio";

/** Below this peak the recording is room tone, and whisper invents words for silence. */
const SILENCE_PEAK_THRESHOLD = 0.012;

const unavailable = (message: string) =>
  new VoiceTranscriptionError({ code: "unavailable", message });

async function readAvailability(environmentId: EnvironmentId) {
  const result = await runAtomCommand(
    appAtomRegistry,
    voiceEnvironment.status,
    { environmentId, input: undefined },
    { reportFailure: false, reportDefect: false },
  );
  return result._tag === "Success" ? result.value.availability : null;
}

async function downloadModel(environmentId: EnvironmentId) {
  const result = await runAtomCommand(
    appAtomRegistry,
    voiceEnvironment.prepareModel,
    { environmentId, input: undefined },
    { reportFailure: false, reportDefect: false },
  );
  return result._tag === "Success" ? result.value.availability : null;
}

async function uploadForTranscription(input: {
  readonly environmentId: EnvironmentId;
  readonly wav: Uint8Array;
  readonly signal: AbortSignal;
}): Promise<string> {
  const minted = await runAtomCommand(
    appAtomRegistry,
    voiceEnvironment.createTranscribeUrl,
    { environmentId: input.environmentId, input: { sizeBytes: input.wav.byteLength } },
    { reportFailure: false, reportDefect: false },
  );
  if (minted._tag !== "Success") {
    throw new VoiceTranscriptionError({
      code: "transcription-failed",
      message: "The environment would not accept the recording.",
    });
  }

  const connection = readPreparedConnection(input.environmentId);
  const url =
    connection === null ? null : resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl);
  if (url === null) {
    throw new VoiceTranscriptionError({
      code: "transcription-failed",
      message: "The environment went offline before the recording could be sent.",
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: new Blob([input.wav as BlobPart], { type: "audio/wav" }),
    signal: input.signal,
  }).catch((cause: unknown) => {
    throwIfVoiceTranscriptionAborted(input.signal);
    throw new VoiceTranscriptionError({
      code: "transcription-failed",
      message: "Could not reach the environment.",
      cause,
    });
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new VoiceTranscriptionError({
      code: response.status === 503 ? "unavailable" : "transcription-failed",
      message: detail.length > 0 ? detail : "Transcription failed.",
    });
  }

  const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof payload?.text !== "string") {
    throw new VoiceTranscriptionError({
      code: "transcription-failed",
      message: "The environment sent no transcript.",
    });
  }
  return payload.text;
}

/**
 * Transcribes through the environment's local whisper.cpp, so the audio never leaves the machine
 * running the server. Remote clients upload to that machine and nowhere else.
 */
export function createServerVoiceTranscriber(environmentId: EnvironmentId): VoiceTranscriber {
  return {
    prepare: async (options: VoiceTranscriptionOptions): Promise<PreparedVoiceTranscription> => {
      throwIfVoiceTranscriptionAborted(options.signal);
      let availability = await readAvailability(environmentId);
      if (availability === null) {
        throw unavailable("Could not reach the environment.");
      }
      if (availability._tag === "binary-missing") {
        throw unavailable(
          `Speech recognition is not installed. Run ${availability.installHint} on the machine running this environment.`,
        );
      }
      if (availability._tag === "model-missing") {
        // One-time, and the controller is already showing the preparing phase.
        availability = await downloadModel(environmentId);
        if (availability === null || availability._tag !== "ready") {
          throw new VoiceTranscriptionError({
            code: "preparation-failed",
            message: "The speech model could not be downloaded.",
          });
        }
      }
      throwIfVoiceTranscriptionAborted(options.signal);

      return {
        // The default model is English-only, so the transcript spaces like English.
        locale: "en",
        transcribe: async (uri: string, transcribeOptions: VoiceTranscriptionOptions) => {
          throwIfVoiceTranscriptionAborted(transcribeOptions.signal);
          const recording = await fetch(uri).then((response) => response.blob());
          const converted = await recordingToWav(recording);
          if (converted === null) {
            throw new VoiceTranscriptionError({
              code: "transcription-failed",
              message: "The recording was empty.",
            });
          }
          // Silence never reaches the server: whisper would answer with invented words.
          if (converted.peak < SILENCE_PEAK_THRESHOLD) return "";
          throwIfVoiceTranscriptionAborted(transcribeOptions.signal);
          return await uploadForTranscription({
            environmentId,
            wav: converted.wav,
            signal: transcribeOptions.signal,
          });
        },
      };
    },
  };
}
