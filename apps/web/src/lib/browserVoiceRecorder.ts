import {
  normalizeVoiceInputDecibels,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "@t3tools/client-runtime/voice-input";

import { preferredRecorderMimeType } from "./voiceDictationAudio";

export type VoiceRecordingSample = {
  readonly durationMillis: number;
  /** 0..1, already on the shared waveform curve. */
  readonly level: number;
};

function rmsDecibels(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}

export function isVoiceCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof OfflineAudioContext !== "undefined"
  );
}

/**
 * Reports a denial the browser already remembers so the controller can offer the settings action
 * instead of a retry. Without the Permissions API the real prompt happens in getUserMedia.
 */
export async function requestMicrophonePermission(): Promise<{
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}> {
  const permissions = navigator.permissions;
  if (permissions?.query === undefined) return { granted: true, canAskAgain: true };
  try {
    const status = await permissions.query({ name: "microphone" as PermissionName });
    return status.state === "denied"
      ? { granted: false, canAskAgain: false }
      : { granted: true, canAskAgain: true };
  } catch {
    // Firefox rejects a "microphone" query outright; fall through to the getUserMedia prompt.
    return { granted: true, canAskAgain: true };
  }
}

export function revokeRecording(uri: string): void {
  if (uri.startsWith("blob:")) URL.revokeObjectURL(uri);
}

/**
 * A `VoiceRecorder` over MediaRecorder. The browser has no recording file, so `uri` is an object
 * URL for the captured blob and only exists once `stop` has run.
 */
export class BrowserVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuffer: Float32Array<ArrayBuffer> | null = null;
  private recordingStartedAt: number | null = null;
  private chunks: Blob[] = [];
  private finished: Promise<void> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onStatus: (status: VoiceRecorderStatus) => void;

  constructor(onStatus: (status: VoiceRecorderStatus) => void) {
    this.onStatus = onStatus;
  }

  async prepareToRecordAsync(signal?: AbortSignal): Promise<void> {
    this.release();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (signal?.aborted) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("Voice recording was cancelled.");
    }
    const mimeType = preferredRecorderMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    this.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    const { promise, resolve } = Promise.withResolvers<void>();
    recorder.onstop = () => {
      this.uri = URL.createObjectURL(
        new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }),
      );
      resolve();
    };
    recorder.onerror = () => {
      this.onStatus({
        isFinished: false,
        hasError: true,
        error: "The microphone stopped unexpectedly.",
        url: null,
      });
    };
    this.stream = stream;
    this.recorder = recorder;
    this.finished = promise;
    this.attachAnalyser(stream);
  }

  /** The live level and elapsed time, or null when not capturing. */
  sample(): VoiceRecordingSample | null {
    if (this.recordingStartedAt === null || this.recorder?.state !== "recording") return null;
    const durationMillis = performance.now() - this.recordingStartedAt;
    if (this.analyser === null || this.analyserBuffer === null) return { durationMillis, level: 0 };
    this.analyser.getFloatTimeDomainData(this.analyserBuffer);
    return { durationMillis, level: normalizeVoiceInputDecibels(rmsDecibels(this.analyserBuffer)) };
  }

  record(options: { readonly forDuration: number }): void {
    this.recorder?.start();
    this.recordingStartedAt = performance.now();
    // A forgotten open microphone is worse than a truncated sentence, and the server rejects
    // anything past the limit anyway.
    this.limitTimer = setTimeout(() => {
      void this.stop().then(() => {
        this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri });
      });
    }, options.forDuration * 1000);
  }

  async stop(): Promise<void> {
    this.clearLimit();
    const recorder = this.recorder;
    if (recorder === null) return;
    if (recorder.state === "recording") {
      recorder.stop();
      await this.finished;
    }
    this.releaseStream();
  }

  /** Stops capture and forgets the recording without touching an already-handed-off object URL. */
  release(): void {
    this.clearLimit();
    if (this.recorder?.state === "recording") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.releaseStream();
    this.recorder = null;
    this.finished = null;
    this.chunks = [];
    this.uri = null;
  }

  private clearLimit(): void {
    if (this.limitTimer !== null) {
      clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
  }

  private attachAnalyser(stream: MediaStream): void {
    // Metering never touches the recorded bytes; MediaRecorder reads the stream directly.
    try {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      this.audioContext = audioContext;
      this.analyser = analyser;
      this.analyserBuffer = new Float32Array(analyser.fftSize);
    } catch {
      // Recording works without a level meter; the waveform just stays flat.
    }
  }

  private releaseStream(): void {
    this.recordingStartedAt = null;
    this.analyser = null;
    this.analyserBuffer = null;
    if (this.audioContext !== null) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    if (this.stream === null) return;
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
  }
}
