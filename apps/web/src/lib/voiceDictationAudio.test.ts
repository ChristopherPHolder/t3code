import { describe, expect, it } from "vite-plus/test";

import { encodeWav, peakAmplitude } from "./voiceDictationAudio";

const ascii = (view: DataView, offset: number, length: number) =>
  Array.from({ length }, (_unused, index) =>
    String.fromCharCode(view.getUint8(offset + index)),
  ).join("");

describe("encodeWav", () => {
  it("writes the 16-bit mono PCM header whisper.cpp requires", () => {
    const wav = encodeWav(new Float32Array(8), 16_000);
    const view = new DataView(wav.buffer);

    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it("sizes the RIFF and data chunks from the sample count", () => {
    const wav = encodeWav(new Float32Array(10), 16_000);
    const view = new DataView(wav.buffer);

    expect(wav.byteLength).toBe(44 + 20);
    expect(view.getUint32(4, true)).toBe(36 + 20);
    expect(view.getUint32(40, true)).toBe(20);
  });

  it("keeps full-scale samples inside the int16 range instead of wrapping", () => {
    const wav = encodeWav(new Float32Array([1, -1, 0, 2, -2]), 16_000);
    const view = new DataView(wav.buffer);

    expect(view.getInt16(44, true)).toBe(32_767);
    expect(view.getInt16(46, true)).toBe(-32_768);
    expect(view.getInt16(48, true)).toBe(0);
    // Out-of-range input clamps rather than overflowing into the opposite sign.
    expect(view.getInt16(50, true)).toBe(32_767);
    expect(view.getInt16(52, true)).toBe(-32_768);
  });
});

describe("peakAmplitude", () => {
  it("reports the loudest sample regardless of sign", () => {
    expect(peakAmplitude(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7);
    expect(peakAmplitude(new Float32Array())).toBe(0);
  });
});
