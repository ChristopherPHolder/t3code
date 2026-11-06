import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VOICE_TRANSCRIBE_ROUTE_PREFIX = "/api/voice/transcribe";
export const VOICE_TRANSCRIBE_URL_TTL_MS = 5 * 60_000;

/**
 * whisper.cpp only reads 16 kHz mono PCM WAV. The client resamples and encodes before upload so
 * the server never needs ffmpeg, which is not installed on most machines.
 */
export const VOICE_SAMPLE_RATE_HZ = 16_000;
/** Mirrors VOICE_RECORDING_LIMIT_SECONDS in client-runtime; the server caps what that can produce. */
const MAX_RECORDING_SECONDS = 300;
const WAV_HEADER_BYTES = 44;
export const VOICE_MAX_AUDIO_BYTES =
  VOICE_SAMPLE_RATE_HZ * 2 * MAX_RECORDING_SECONDS + WAV_HEADER_BYTES;

export const VOICE_DEFAULT_MODEL = "ggml-base.en.bin";

/** Why dictation cannot run, or the model it will run with. The client renders each case. */
export const VoiceAvailability = Schema.Union([
  Schema.TaggedStruct("ready", {
    modelName: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("binary-missing", {
    /** The exact command to run, chosen for the server's platform. */
    installHint: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("model-missing", {
    modelName: TrimmedNonEmptyString,
    downloadBytes: NonNegativeInt,
  }),
]);
export type VoiceAvailability = typeof VoiceAvailability.Type;

export const VoiceStatusResult = Schema.Struct({
  availability: VoiceAvailability,
});
export type VoiceStatusResult = typeof VoiceStatusResult.Type;

export const VoicePrepareModelResult = Schema.Struct({
  availability: VoiceAvailability,
});
export type VoicePrepareModelResult = typeof VoicePrepareModelResult.Type;

export const VoiceCreateTranscribeUrlInput = Schema.Struct({
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(VOICE_MAX_AUDIO_BYTES),
  ),
});
export type VoiceCreateTranscribeUrlInput = typeof VoiceCreateTranscribeUrlInput.Type;

export const VoiceCreateTranscribeUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type VoiceCreateTranscribeUrlResult = typeof VoiceCreateTranscribeUrlResult.Type;

/** The body the transcribe route returns on success. */
export const VoiceTranscribeResponse = Schema.Struct({
  text: Schema.String,
});
export type VoiceTranscribeResponse = typeof VoiceTranscribeResponse.Type;

export class VoiceTranscribeSigningKeyError extends Schema.TaggedError<VoiceTranscribeSigningKeyError>()(
  "VoiceTranscribeSigningKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the voice transcription signing key.";
  }
}

export class VoiceModelDownloadError extends Schema.TaggedError<VoiceModelDownloadError>()(
  "VoiceModelDownloadError",
  {
    modelName: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not download the speech model ${this.modelName}: ${this.detail}`;
  }
}
