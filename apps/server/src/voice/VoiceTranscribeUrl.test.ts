import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { VOICE_MAX_AUDIO_BYTES, VOICE_TRANSCRIBE_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import { issueVoiceTranscribeUrl, validateVoiceTranscribeToken } from "./VoiceTranscribeUrl.ts";

const layerTest = AssetSigner.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-url-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const tokenOf = (relativeUrl: string) =>
  relativeUrl.slice(`${VOICE_TRANSCRIBE_ROUTE_PREFIX}/`.length);

describe("VoiceTranscribeUrl", () => {
  it.effect("accepts the token it issued and reports the signed size", () =>
    Effect.gen(function* () {
      const issued = yield* issueVoiceTranscribeUrl({ sizeBytes: 4_096 });
      expect(issued.relativeUrl.startsWith(`${VOICE_TRANSCRIBE_ROUTE_PREFIX}/`)).toBe(true);

      const claims = yield* validateVoiceTranscribeToken(tokenOf(issued.relativeUrl));
      expect(claims?.sizeBytes).toBe(4_096);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects a token whose payload was edited to allow a larger upload", () =>
    Effect.gen(function* () {
      const issued = yield* issueVoiceTranscribeUrl({ sizeBytes: 4_096 });
      const [, signature] = tokenOf(issued.relativeUrl).split(".");
      const forgedPayload = base64UrlEncode(
        JSON.stringify({
          version: 1,
          kind: "voice-transcribe",
          sizeBytes: VOICE_MAX_AUDIO_BYTES * 10,
          expiresAt: Number.MAX_SAFE_INTEGER,
        }),
      );

      expect(yield* validateVoiceTranscribeToken(`${forgedPayload}.${signature}`)).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects a malformed token", () =>
    Effect.gen(function* () {
      expect(yield* validateVoiceTranscribeToken("nonsense")).toBeNull();
      expect(yield* validateVoiceTranscribeToken("a.b.c")).toBeNull();
      expect(yield* validateVoiceTranscribeToken("")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects the token once it expires", () =>
    Effect.gen(function* () {
      const issued = yield* issueVoiceTranscribeUrl({ sizeBytes: 1_024 });
      const token = tokenOf(issued.relativeUrl);
      expect(yield* validateVoiceTranscribeToken(token)).not.toBeNull();

      yield* TestClock.adjust("11 minutes");
      expect(yield* validateVoiceTranscribeToken(token)).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );
});
