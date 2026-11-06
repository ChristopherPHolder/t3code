import type { EnvironmentId } from "@t3tools/contracts";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useRef, useState } from "react";

import {
  BrowserVoiceRecorder,
  isVoiceCaptureSupported,
  requestMicrophonePermission,
  revokeRecording,
} from "../lib/browserVoiceRecorder";
import { createServerVoiceTranscriber } from "../lib/serverVoiceTranscriber";
import { VoiceLevelFeed } from "../lib/voiceLevelFeed";

/** Matches mobile so the waveform scrolls at the same pace on every client. */
const METERING_INTERVAL_MS = 80;

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export interface VoiceInputHandle {
  readonly supported: boolean;
  readonly state: VoiceInputState;
  readonly busy: boolean;
  /** Whole seconds recorded so far; 0 outside the recording phase. */
  readonly elapsedSeconds: number;
  readonly levels: VoiceLevelFeed;
  readonly start: () => void;
  /** Finish the recording and insert its transcript. */
  readonly stop: () => void;
  /** Drop the recording, or clear an error, without changing the draft. */
  readonly cancel: () => void;
}

export function useVoiceInput(input: {
  readonly environmentId: EnvironmentId | null;
  readonly ownerKey: string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly disabled: boolean;
}): VoiceInputHandle {
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [levels] = useState(() => new VoiceLevelFeed());
  const supported = isVoiceCaptureSupported();

  // The controller owns a live microphone and an in-flight upload, so it must survive renders and
  // always call into the composer's current draft, never the one captured when it was built.
  const latest = useRef(input);
  const controllerRef = useRef<{
    readonly controller: VoiceInputController;
    readonly recorder: BrowserVoiceRecorder;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the controller's draft and environment accessors pointing at the current render's props; transcription settles long after start().
  useEffect(() => {
    latest.current = input;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Builds and tears down the microphone and transcription session, which live outside React and must be released on unmount.
  useEffect(() => {
    if (!supported) return;
    const recorder = new BrowserVoiceRecorder((status) => {
      void controllerRef.current?.controller.handleRecorderStatus(status);
    });
    const controller = new VoiceInputController({
      recorder,
      getTranscriber: () => {
        const environmentId = latest.current.environmentId;
        return environmentId === null ? null : createServerVoiceTranscriber(environmentId);
      },
      requestPermission: requestMicrophonePermission,
      configureRecording: () => Promise.resolve(),
      releaseRecording: () => Promise.resolve(),
      deleteRecording: revokeRecording,
      readDraft: () => latest.current.readDraft(),
      commitDraft: (text, selection) => latest.current.commitDraft(text, selection),
      onStateChange: setState,
    });
    controllerRef.current = { controller, recorder };
    return () => {
      controller.dispose();
      recorder.release();
      controllerRef.current = null;
    };
  }, [supported]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape must drop a live recording from anywhere in the composer; the microphone stays open until something stops it, so this is a document listener bound to the recording's lifetime.
  useEffect(() => {
    if (state.phase !== "recording" && state.phase !== "preparing") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      controllerRef.current?.controller.cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [state.phase]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls the live microphone for the waveform and clock while recording; the levels live outside React and only the whole-second clock re-renders.
  useEffect(() => {
    if (state.phase !== "recording") return;
    levels.reset();
    const tick = () => {
      const sample = controllerRef.current?.recorder.sample();
      if (!sample) return;
      levels.push(sample.level);
      const seconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.floor(sample.durationMillis / 1_000),
      );
      setElapsedSeconds((previous) => (previous === seconds ? previous : seconds));
    };
    tick();
    const interval = setInterval(tick, METERING_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      setElapsedSeconds(0);
    };
  }, [state.phase, levels]);

  const start = () => {
    if (input.disabled || input.environmentId === null) return;
    void controllerRef.current?.controller.start();
  };

  return {
    supported,
    state,
    busy: voiceInputBlocksSubmission(state),
    elapsedSeconds,
    levels,
    start,
    stop: () => void controllerRef.current?.controller.stop(),
    cancel: () => controllerRef.current?.controller.cancel(),
  };
}
