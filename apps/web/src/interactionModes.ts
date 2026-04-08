import type { ProviderInteractionMode, ProviderKind } from "@t3tools/contracts";

export const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Chat",
  plan: "Plan",
  autopilot: "Autopilot",
};

export function getInteractionModesForProvider(
  provider: ProviderKind,
): ReadonlyArray<ProviderInteractionMode> {
  return provider === "copilot" ? ["default", "plan", "autopilot"] : ["default", "plan"];
}

export function normalizeInteractionModeForProvider(
  provider: ProviderKind,
  interactionMode: ProviderInteractionMode,
): ProviderInteractionMode {
  return provider === "copilot" || interactionMode !== "autopilot" ? interactionMode : "default";
}
