import { describe, expect, it } from "vite-plus/test";

import {
  buildWhisperArgs,
  isSafeModelName,
  installHintForPlatform,
  parseWhisperTranscript,
  resolveModelName,
} from "./whisperCli.ts";

describe("parseWhisperTranscript", () => {
  it("joins the transcript lines whisper.cpp prints", () => {
    expect(
      parseWhisperTranscript(" Add a retry to the upload queue.\n Then run the tests.\n"),
    ).toBe("Add a retry to the upload queue. Then run the tests.");
  });

  it("drops the non-speech annotations whisper.cpp emits for silence and noise", () => {
    expect(parseWhisperTranscript("[BLANK_AUDIO]\n")).toBe("");
    expect(parseWhisperTranscript("(wind blowing)\n*clears throat*\n Ship it.\n")).toBe("Ship it.");
  });

  it("keeps a line that merely contains brackets", () => {
    expect(parseWhisperTranscript(" Rename the [draft] flag.\n")).toBe("Rename the [draft] flag.");
  });
});

describe("resolveModelName", () => {
  it("falls back to the default when the configured name could escape the model directory", () => {
    expect(resolveModelName("../../etc/passwd")).toBe("ggml-base.en.bin");
    expect(resolveModelName("ggml-../evil.bin")).toBe("ggml-base.en.bin");
    expect(resolveModelName("  ")).toBe("ggml-base.en.bin");
    expect(resolveModelName(undefined)).toBe("ggml-base.en.bin");
  });

  it("keeps a well-formed model name", () => {
    expect(resolveModelName("ggml-small.en.bin")).toBe("ggml-small.en.bin");
  });

  it("rejects names that are not whisper models", () => {
    expect(isSafeModelName("model.bin")).toBe(false);
    expect(isSafeModelName("ggml-base.en.sh")).toBe(false);
    expect(isSafeModelName("ggml-base.en.bin")).toBe(true);
  });
});

describe("buildWhisperArgs", () => {
  it("forces English for an .en model and auto-detects otherwise", () => {
    const english = buildWhisperArgs({
      modelPath: "/models/ggml-base.en.bin",
      audioPath: "/tmp/a.wav",
      modelName: "ggml-base.en.bin",
    });
    expect(english.slice(english.indexOf("-l"), english.indexOf("-l") + 2)).toEqual(["-l", "en"]);

    const multilingual = buildWhisperArgs({
      modelPath: "/models/ggml-base.bin",
      audioPath: "/tmp/a.wav",
      modelName: "ggml-base.bin",
    });
    expect(multilingual.slice(multilingual.indexOf("-l"), multilingual.indexOf("-l") + 2)).toEqual([
      "-l",
      "auto",
    ]);
  });

  it("suppresses timestamps and the banner so stdout is only the transcript", () => {
    const args = buildWhisperArgs({
      modelPath: "/models/m.bin",
      audioPath: "/tmp/a.wav",
      modelName: "ggml-base.en.bin",
    });
    expect(args).toContain("-nt");
    expect(args).toContain("-np");
  });
});

describe("installHintForPlatform", () => {
  it("names a package manager the platform actually has", () => {
    expect(installHintForPlatform("darwin")).toBe("brew install whisper-cpp");
    expect(installHintForPlatform("win32")).toContain("winget");
    expect(installHintForPlatform("linux")).toContain("whisper");
  });
});
