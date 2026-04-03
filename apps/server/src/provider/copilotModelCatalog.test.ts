import { describe, expect, it } from "vitest";

import { parseCopilotModelPickerOutput } from "./copilotModelCatalog";

describe("parseCopilotModelPickerOutput", () => {
  it("parses available Copilot models and premium request multipliers", () => {
    const output = `
      \u001b[2JSelect Model
      Search models...
      ❯ Claude Sonnet 4.6                                  1x
        Claude Haiku 4.5                                   0.33x
        Claude Opus 4.6 (1M Context)                       6x
        GPT-5.4 mini                                       0.33x
        GPT-5 mini                                         0x
        Goldeneye                                          1x
      ↑↓ to navigate • Enter to select • Esc to cancel
    `;

    expect(parseCopilotModelPickerOutput(output)).toEqual([
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        premiumRequestMultiplier: "1x",
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        premiumRequestMultiplier: "0.33x",
      },
      {
        slug: "claude-opus-4-6-1m",
        name: "Claude Opus 4.6 (1M Context)",
        premiumRequestMultiplier: "6x",
      },
      {
        slug: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        premiumRequestMultiplier: "0.33x",
      },
      {
        slug: "gpt-5-mini",
        name: "GPT-5 mini",
        premiumRequestMultiplier: "0x",
      },
      {
        slug: "goldeneye",
        name: "Goldeneye",
        premiumRequestMultiplier: "1x",
      },
    ]);
  });
});
