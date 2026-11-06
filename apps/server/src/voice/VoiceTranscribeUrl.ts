import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_TRANSCRIBE_ROUTE_PREFIX,
  VOICE_TRANSCRIBE_URL_TTL_MS,
  VoiceTranscribeSigningKeyError,
  type VoiceCreateTranscribeUrlInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";

const VoiceTranscribeClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("voice-transcribe"),
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
export type VoiceTranscribeClaims = typeof VoiceTranscribeClaims.Type;

const voiceTranscribeClaimsJson = Schema.fromJsonString(VoiceTranscribeClaims);
const decodeVoiceTranscribeClaims = Schema.decodeUnknownOption(voiceTranscribeClaimsJson);
const encodeVoiceTranscribeClaims = Schema.encodeSync(voiceTranscribeClaimsJson);

function decodeClaims(encodedPayload: string): VoiceTranscribeClaims | null {
  try {
    return Option.getOrNull(decodeVoiceTranscribeClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

export const issueVoiceTranscribeUrl = Effect.fn("VoiceTranscribeUrl.issueUrl")(function* (
  input: VoiceCreateTranscribeUrlInput,
) {
  const expiresAt = (yield* Clock.currentTimeMillis) + VOICE_TRANSCRIBE_URL_TTL_MS;
  const encodedPayload = base64UrlEncode(
    encodeVoiceTranscribeClaims({
      version: 1,
      kind: "voice-transcribe",
      sizeBytes: input.sizeBytes,
      expiresAt,
    }),
  );
  const signer = yield* AssetSigner.AssetSigner;
  const signature = yield* signer
    .sign(encodedPayload)
    .pipe(Effect.mapError((cause) => new VoiceTranscribeSigningKeyError({ cause })));
  return {
    relativeUrl: `${VOICE_TRANSCRIBE_ROUTE_PREFIX}/${encodedPayload}.${signature}`,
    expiresAt,
  };
});

export const validateVoiceTranscribeToken = Effect.fn("VoiceTranscribeUrl.validateToken")(
  function* (token: string) {
    const [encodedPayload, signature, unexpectedSegment] = token.split(".");
    if (!encodedPayload || !signature || unexpectedSegment) {
      return null;
    }

    const signer = yield* AssetSigner.AssetSigner;
    const verified = yield* signer.verify(encodedPayload, signature).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to load the voice transcription signing key.", { cause }),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (!verified) {
      return null;
    }

    const claims = decodeClaims(encodedPayload);
    if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) {
      return null;
    }
    // The signature covers the size, so a token cannot be replayed to push a larger recording.
    if (claims.sizeBytes < 1 || claims.sizeBytes > VOICE_MAX_AUDIO_BYTES) {
      return null;
    }
    return claims;
  },
);
