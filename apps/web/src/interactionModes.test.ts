import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getInteractionModesForProvider,
  normalizeInteractionModeForProvider,
} from "./interactionModes";

describe("interaction modes", () => {
  it("offers autopilot only for GitHub Copilot", () => {
    expect(getInteractionModesForProvider(ProviderDriverKind.make("copilot"))).toContain(
      "autopilot",
    );
    expect(getInteractionModesForProvider(ProviderDriverKind.make("codex"))).not.toContain(
      "autopilot",
    );
  });

  it("normalizes autopilot to build mode for unsupported providers", () => {
    expect(normalizeInteractionModeForProvider(ProviderDriverKind.make("codex"), "autopilot")).toBe(
      "default",
    );
  });
});
