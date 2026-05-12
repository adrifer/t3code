import { type ProviderInteractionMode, ProviderDriverKind } from "@t3tools/contracts";

const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");

export const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Build",
  plan: "Plan",
  autopilot: "Autopilot",
};

export function getInteractionModesForProvider(
  provider: ProviderDriverKind,
): ReadonlyArray<ProviderInteractionMode> {
  return provider === COPILOT_DRIVER_KIND ? ["default", "plan", "autopilot"] : ["default", "plan"];
}

export function normalizeInteractionModeForProvider(
  provider: ProviderDriverKind,
  interactionMode: ProviderInteractionMode,
): ProviderInteractionMode {
  return provider === COPILOT_DRIVER_KIND || interactionMode !== "autopilot"
    ? interactionMode
    : "default";
}
