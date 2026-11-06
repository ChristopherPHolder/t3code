import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { MicIcon } from "lucide-react";
import { memo } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

/** The idle entry point. Once dictation starts, ComposerDictationBar takes over the footer. */
export const ComposerVoiceButton = memo(function ComposerVoiceButton(props: {
  state: VoiceInputState;
  disabledReason: string | null;
  onStart: () => void;
}) {
  const tooltip =
    props.disabledReason ??
    (props.state.phase === "error" ? "Try dictating again" : "Dictate a message");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            type="button"
            data-chat-composer-voice={props.state.phase}
            aria-label={tooltip}
            disabled={props.disabledReason !== null}
            className="shrink-0"
            onClick={props.onStart}
          />
        }
      >
        <ComposerControlIcon icon={MicIcon} />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
});
