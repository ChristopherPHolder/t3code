import { VOICE_WAVEFORM_SAMPLE_COUNT } from "@t3tools/client-runtime/voice-input";

/** Levels arrive every metering tick, so they bypass React state and paint straight to a canvas. */
export class VoiceLevelFeed {
  readonly levels = new Float32Array(VOICE_WAVEFORM_SAMPLE_COUNT);
  private readonly listeners = new Set<() => void>();

  push(level: number): void {
    this.levels.copyWithin(0, 1);
    this.levels[this.levels.length - 1] = level;
    this.notify();
  }

  reset(): void {
    this.levels.fill(0);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
