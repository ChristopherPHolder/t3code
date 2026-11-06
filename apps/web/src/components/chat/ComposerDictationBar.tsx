import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import type { VoiceLevelFeed } from "~/lib/voiceLevelFeed";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { composerActionCircleClassName } from "./ComposerPrimaryActions";

const BAR_SPACING_PX = 5;
const BAR_WIDTH_PX = 2;
const BAR_MIN_HEIGHT_PX = 2;

/**
 * Paints on each metering tick rather than every frame: the only repaint while the agent streams
 * is this small canvas, about twelve times a second, and nothing when the level is unchanged.
 */
function paintWaveform(canvas: HTMLCanvasElement, levels: Float32Array): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  const scale = window.devicePixelRatio || 1;
  const bitmapWidth = Math.round(width * scale);
  const bitmapHeight = Math.round(height * scale);
  if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
    canvas.width = bitmapWidth;
    canvas.height = bitmapHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, bitmapWidth, bitmapHeight);
  context.fillStyle = getComputedStyle(canvas).color;

  const count = Math.max(1, Math.min(levels.length, Math.floor(width / BAR_SPACING_PX)));
  const step = bitmapWidth / count;
  const barWidth = BAR_WIDTH_PX * scale;
  const minHeight = BAR_MIN_HEIGHT_PX * scale;
  for (let index = 0; index < count; index += 1) {
    const level = levels[levels.length - count + index] ?? 0;
    const barHeight = minHeight + level * (bitmapHeight - minHeight);
    const x = index * step + (step - barWidth) / 2;
    const y = (bitmapHeight - barHeight) / 2;
    context.globalAlpha = 0.22 + level * 0.78;
    context.beginPath();
    context.roundRect(x, y, barWidth, barHeight, barWidth / 2);
    context.fill();
  }
}

function VoiceWaveform(props: { readonly levels: VoiceLevelFeed }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { levels } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The canvas is painted imperatively from the level feed, which updates far too often for React state.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = () => paintWaveform(canvas, levels.levels);
    paint();
    return levels.subscribe(paint);
  }, [levels]);

  return (
    <canvas ref={canvasRef} aria-hidden="true" className="h-8 min-w-0 flex-1 text-foreground" />
  );
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Takes over the composer footer while dictating: discard · live waveform and clock · finish. */
export const ComposerDictationBar = memo(function ComposerDictationBar(props: {
  state: VoiceInputState;
  elapsedSeconds: number;
  levels: VoiceLevelFeed;
  className?: string | undefined;
  onStop: () => void;
  onCancel: () => void;
}) {
  const phase = props.state.phase;
  const recording = phase === "recording";
  const status =
    phase === "preparing"
      ? "Starting microphone…"
      : phase === "transcribing"
        ? "Transcribing…"
        : null;

  return (
    <div
      data-chat-composer-dictation={phase}
      role="group"
      aria-label={recording ? "Recording" : (status ?? "Dictation")}
      className={cn("flex items-center gap-2", props.className)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              type="button"
              aria-label="Discard this recording"
              className="shrink-0"
              onClick={props.onCancel}
            />
          }
        >
          <ComposerControlIcon icon={XIcon} />
        </TooltipTrigger>
        <TooltipPopup side="top">Discard (Escape)</TooltipPopup>
      </Tooltip>

      <div className="flex h-8 min-w-0 flex-1 items-center gap-3 px-1">
        {recording ? (
          <>
            <VoiceWaveform levels={props.levels} />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatElapsed(props.elapsedSeconds)}
            </span>
          </>
        ) : (
          <span aria-live="polite" className="truncate text-sm text-muted-foreground">
            {status}
          </span>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <button
            type="button"
            className={composerActionCircleClassName}
            disabled={!recording}
            aria-label="Finish recording and insert the transcript"
            onClick={props.onStop}
          >
            {recording ? (
              <CheckIcon className="size-4" aria-hidden="true" />
            ) : (
              <Spinner size="sm" aria-hidden="true" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipPopup side="top">Finish and insert the transcript</TooltipPopup>
      </Tooltip>
    </div>
  );
});

export function ComposerDictationError(props: {
  readonly error: string | null;
  readonly onDismiss: () => void;
}) {
  if (!props.error) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 pb-1">
      <span role="alert" className="min-w-0 flex-1 truncate text-sm text-destructive">
        {props.error}
      </span>
      <ComposerControl
        type="button"
        size="xs"
        aria-label="Dismiss voice input error"
        className="shrink-0"
        onClick={props.onDismiss}
      >
        <ComposerControlIcon icon={XIcon} size="xs" />
      </ComposerControl>
    </div>
  );
}
