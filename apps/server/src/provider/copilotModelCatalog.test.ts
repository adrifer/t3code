import { describe, expect, it } from "@effect/vitest";

import {
  FALLBACK_COPILOT_MODEL_CATALOG,
  parseCopilotModelPickerOutput,
} from "./copilotModelCatalog.ts";

describe("parseCopilotModelPickerOutput", () => {
  it("parses available Copilot models and premium request multipliers", () => {
    const output = `
      \u001b[2JSelect Model
      Search models...
      ❯ Claude Sonnet 4.6                                  1x
        Claude Haiku 4.5                                   0.33x
        Claude Opus 4.7                                    3x
        Claude Opus 4.6                                    3x
        GPT-5.4 mini                                       0.33x
        GPT-5 mini                                         0x
        Gemini 3.6 Flash                                   1x
        MAI-Code-1-Flash                                   0.33x
        Raptor mini                                        0.33x
        Kimi K2.7 Code                                     1x
        Grok 4.5                                           1x
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
        slug: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        premiumRequestMultiplier: "3x",
      },
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        premiumRequestMultiplier: "3x",
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
        slug: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        premiumRequestMultiplier: "1x",
      },
      {
        slug: "mai-code-1-flash",
        name: "MAI-Code-1-Flash",
        premiumRequestMultiplier: "0.33x",
      },
      {
        slug: "raptor-mini",
        name: "Raptor mini",
        premiumRequestMultiplier: "0.33x",
      },
      {
        slug: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        premiumRequestMultiplier: "1x",
      },
      {
        slug: "grok-4.5",
        name: "Grok 4.5",
        premiumRequestMultiplier: "1x",
      },
      {
        slug: "goldeneye",
        name: "Goldeneye",
        premiumRequestMultiplier: "1x",
      },
    ]);
  });

  it("parses the first real model when the Auto picker row is active", () => {
    const output = `
      Select Model
      Search models...
      ❯ Auto  Claude Sonnet 4.6                                  1x  Claude Sonnet 4.5                                  1x  Claude Opus 4.7                                  7.5x
      ↑↓ to navigate · Tab switch tab · Enter to select · Esc to cancel
    `;

    expect(parseCopilotModelPickerOutput(output)).toEqual([
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        premiumRequestMultiplier: "1x",
      },
      {
        slug: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        premiumRequestMultiplier: "1x",
      },
      {
        slug: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        premiumRequestMultiplier: "7.5x",
      },
    ]);
  });

  it("keeps the fallback catalog aligned with the current Copilot model families", () => {
    const slugs = new Set(FALLBACK_COPILOT_MODEL_CATALOG.map((model) => model.slug));

    for (const slug of [
      "auto",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "gemini-3.6-flash",
      "mai-code-1-flash",
      "raptor-mini",
      "kimi-k2.7-code",
      "grok-4.5",
    ]) {
      expect(slugs.has(slug)).toBe(true);
    }
  });
});
