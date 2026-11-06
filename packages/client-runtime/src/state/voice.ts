import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:status",
      tag: WS_METHODS.voiceStatus,
    }),
    prepareModel: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:prepare-model",
      tag: WS_METHODS.voicePrepareModel,
    }),
    createTranscribeUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:create-transcribe-url",
      tag: WS_METHODS.voiceCreateTranscribeUrl,
    }),
  };
}
