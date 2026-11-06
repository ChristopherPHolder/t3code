import { VOICE_DEFAULT_MODEL } from "@t3tools/contracts";

/**
 * Homebrew installs the binary as `whisper-cli`; builds from source leave it as `main` or
 * `whisper`. Older Homebrew formulae shipped `whisper-cpp`.
 */
export const WHISPER_BINARY_CANDIDATES = ["whisper-cli", "whisper-cpp", "whisper"] as const;

const WHISPER_MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** Approximate on-disk sizes, used only to tell the user what a first-run download costs. */
const MODEL_DOWNLOAD_BYTES: Readonly<Record<string, number>> = {
  "ggml-tiny.en.bin": 77_700_000,
  "ggml-tiny.bin": 77_700_000,
  "ggml-base.en.bin": 147_950_000,
  "ggml-base.bin": 147_950_000,
  "ggml-small.en.bin": 487_600_000,
  "ggml-small.bin": 487_600_000,
};

const FALLBACK_DOWNLOAD_BYTES = 147_950_000;

export function modelDownloadBytes(modelName: string): number {
  return MODEL_DOWNLOAD_BYTES[modelName] ?? FALLBACK_DOWNLOAD_BYTES;
}

export function modelDownloadUrl(modelName: string): string {
  return `${WHISPER_MODEL_BASE_URL}/${modelName}`;
}

/** Rejects names that would escape the model directory or fetch something other than a model. */
export function isSafeModelName(modelName: string): boolean {
  return /^ggml-[a-z0-9.\-_]+\.bin$/i.test(modelName) && !modelName.includes("..");
}

export function resolveModelName(configured: string | undefined): string {
  const trimmed = configured?.trim();
  return trimmed && isSafeModelName(trimmed) ? trimmed : VOICE_DEFAULT_MODEL;
}

export function installHintForPlatform(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "brew install whisper-cpp";
  if (platform === "win32") return "winget install ggerganov.whisper.cpp";
  return "sudo apt install whisper.cpp  # or build from github.com/ggml-org/whisper.cpp";
}

/** `.en` models are English-only and reject language detection. */
function languageForModel(modelName: string): string {
  return /\.en\.bin$/i.test(modelName) ? "en" : "auto";
}

export function buildWhisperArgs(input: {
  readonly modelPath: string;
  readonly audioPath: string;
  readonly modelName: string;
}): ReadonlyArray<string> {
  return [
    "-m",
    input.modelPath,
    "-f",
    input.audioPath,
    "-l",
    languageForModel(input.modelName),
    // Transcript only: no timestamps, and no banner or progress on stdout.
    "-nt",
    "-np",
  ];
}

/**
 * whisper.cpp emits non-speech annotations such as `[BLANK_AUDIO]` or `(wind blowing)` for silence
 * and background noise. They are never dictation, so a recording of only those yields empty text.
 */
const NON_SPEECH_LINE = /^\s*(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)\s*$/;

export function parseWhisperTranscript(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NON_SPEECH_LINE.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
