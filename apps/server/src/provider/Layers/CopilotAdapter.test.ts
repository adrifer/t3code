import { describe, expect, it } from "@effect/vitest";

import { mapInteractionModeToSessionMode } from "./CopilotAdapter.ts";

describe("mapInteractionModeToSessionMode", () => {
  it("preserves Copilot autopilot mode", () => {
    expect(mapInteractionModeToSessionMode("autopilot")).toBe("autopilot");
  });
});
