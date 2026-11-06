import { VOICE_SAMPLE_RATE_HZ } from "@t3tools/contracts";

const WAV_HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

/** Mono 16-bit PCM WAV, the only container whisper.cpp reads. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8;

  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, (CHANNELS * BITS_PER_SAMPLE) / 8, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    // -32768 and 32767 are asymmetric; scaling negatives by 0x8000 keeps full-scale audio from wrapping.
    view.setInt16(
      WAV_HEADER_BYTES + index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return bytes;
}

/** Peak amplitude of the recording, used to tell silence from speech before a round trip. */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index] ?? 0);
    if (value > peak) peak = value;
  }
  return peak;
}

/**
 * Decodes whatever MediaRecorder produced and re-renders it as 16 kHz mono through
 * OfflineAudioContext, so the browser's own resampler does the work and the server needs no
 * transcoder.
 */
export async function recordingToWav(
  recording: Blob,
): Promise<{ readonly wav: Uint8Array; readonly peak: number } | null> {
  const buffer = await recording.arrayBuffer();
  if (buffer.byteLength === 0) return null;

  const decodeContext = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeContext.decodeAudioData(buffer);
  } catch {
    return null;
  } finally {
    void decodeContext.close();
  }

  const frames = Math.ceil(decoded.duration * VOICE_SAMPLE_RATE_HZ);
  if (frames <= 0) return null;
  const offline = new OfflineAudioContext(CHANNELS, frames, VOICE_SAMPLE_RATE_HZ);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  return { wav: encodeWav(samples, VOICE_SAMPLE_RATE_HZ), peak: peakAmplitude(samples) };
}

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export function preferredRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}
