import type { CopilotSettings } from "@t3tools/contracts";
import { Effect } from "effect";

import { PtyAdapter } from "../terminal/Services/PTY";
import { resolveCommandExecution } from "../wsl";

export interface CopilotModelCatalogEntry {
  readonly slug: string;
  readonly name: string;
  readonly premiumRequestMultiplier?: string;
}

export type CopilotModelCatalogProbeSettings = Pick<
  CopilotSettings,
  "binaryPath" | "useWsl" | "wslDistro"
>;

export const FALLBACK_COPILOT_MODEL_CATALOG: ReadonlyArray<CopilotModelCatalogEntry> = [
  { slug: "gpt-5.4", name: "GPT-5.4", premiumRequestMultiplier: "1x" },
  { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini", premiumRequestMultiplier: "0.33x" },
  { slug: "gpt-5-mini", name: "GPT-5 Mini", premiumRequestMultiplier: "0x" },
  { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex", premiumRequestMultiplier: "1x" },
  { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex", premiumRequestMultiplier: "1x" },
  { slug: "gpt-5.2", name: "GPT-5.2", premiumRequestMultiplier: "1x" },
  { slug: "gpt-5.1", name: "GPT-5.1", premiumRequestMultiplier: "1x" },
  { slug: "gpt-4.1", name: "GPT-4.1", premiumRequestMultiplier: "0x" },
  { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", premiumRequestMultiplier: "1x" },
  { slug: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", premiumRequestMultiplier: "1x" },
  { slug: "claude-sonnet-4", name: "Claude Sonnet 4", premiumRequestMultiplier: "1x" },
  { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", premiumRequestMultiplier: "0.33x" },
  { slug: "claude-opus-4-6", name: "Claude Opus 4.6", premiumRequestMultiplier: "3x" },
  {
    slug: "claude-opus-4-6-1m",
    name: "Claude Opus 4.6 (1M Context)",
    premiumRequestMultiplier: "6x",
  },
  { slug: "claude-opus-4-5", name: "Claude Opus 4.5", premiumRequestMultiplier: "3x" },
  { slug: "goldeneye", name: "Goldeneye", premiumRequestMultiplier: "1x" },
];

const MODEL_PICKER_READY_MARKERS = ["Select Model", "Search models..."] as const;
const MODEL_PICKER_FOOTER_MARKERS = ["↑↓ to navigate", "Esc to cancel"] as const;
const MODEL_PICKER_SECTION_START = "Search models...";
const OSC_CONTROL_SEQUENCE = new RegExp(String.raw`\u001b\][\s\S]*?(?:\u0007|\u001b\\)`, "g");
const STRING_CONTROL_SEQUENCE = new RegExp(String.raw`\u001b[P^_][\s\S]*?(?:\u0007|\u001b\\)`, "g");
const CSI_CONTROL_SEQUENCE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");
const SINGLE_ESCAPE_SEQUENCE = new RegExp(String.raw`\u001b[@-_]`, "g");
const CONTROL_CHARACTERS = new RegExp(String.raw`[\u0000-\u0008\u000b-\u001f\u007f-\u009f]`, "g");

function stripTerminalControlSequences(input: string): string {
  return input
    .replace(OSC_CONTROL_SEQUENCE, "")
    .replace(STRING_CONTROL_SEQUENCE, "")
    .replace(CSI_CONTROL_SEQUENCE, "")
    .replace(SINGLE_ESCAPE_SEQUENCE, "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

function cleanCopilotModelDisplayName(input: string): string {
  return input
    .replace(/[✓]/g, "")
    .replace(/\s+\((?:default|current)\)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugFromCopilotModelDisplayName(displayName: string): string | null {
  const normalized = cleanCopilotModelDisplayName(displayName);
  if (!normalized) {
    return null;
  }

  if (/^goldeneye\b/i.test(normalized)) {
    return "goldeneye";
  }

  if (/^gpt-/i.test(normalized)) {
    return normalized.toLowerCase().replace(/\s+/g, "-");
  }

  const claudeMatch = /^Claude\s+(Sonnet|Opus|Haiku)\s+(\d+(?:\.\d+)?)(?<suffix>.*)$/i.exec(
    normalized,
  );
  if (!claudeMatch) {
    return null;
  }

  const family = claudeMatch[1]!.toLowerCase();
  const version = claudeMatch[2]!.replaceAll(".", "-");
  const suffix = claudeMatch.groups?.suffix?.toLowerCase() ?? "";

  let slug = `claude-${family}-${version}`;
  if (suffix.includes("1m")) {
    slug += "-1m";
  } else if (suffix.includes("fast")) {
    slug += "-fast";
  }
  return slug;
}

function extractModelPickerSection(output: string): string | null {
  const sanitized = stripTerminalControlSequences(output);
  const start = sanitized.indexOf(MODEL_PICKER_SECTION_START);
  if (start === -1) {
    return null;
  }

  const afterStart = sanitized.slice(start + MODEL_PICKER_SECTION_START.length);
  const footerIndex = MODEL_PICKER_FOOTER_MARKERS.reduce<number>((current, marker) => {
    const index = afterStart.indexOf(marker);
    if (index === -1) {
      return current;
    }
    return current === -1 ? index : Math.min(current, index);
  }, -1);

  return (footerIndex === -1 ? afterStart : afterStart.slice(0, footerIndex)).trim();
}

export function parseCopilotModelPickerOutput(
  output: string,
): ReadonlyArray<CopilotModelCatalogEntry> {
  const section = extractModelPickerSection(output);
  if (!section) {
    return [];
  }

  const seen = new Set<string>();
  const entries: CopilotModelCatalogEntry[] = [];
  const matcher = /(?:❯\s*)?([A-Za-z0-9][A-Za-z0-9 .()/-]*?)\s{2,}(\d+(?:\.\d+)?x)\b/g;

  for (const match of section.matchAll(matcher)) {
    const displayName = cleanCopilotModelDisplayName(match[1] ?? "");
    const premiumRequestMultiplier = match[2]?.trim();
    const slug = slugFromCopilotModelDisplayName(displayName);

    if (!slug || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    entries.push({
      slug,
      name: displayName,
      ...(premiumRequestMultiplier ? { premiumRequestMultiplier } : {}),
    });
  }

  return entries;
}

function hasModelPickerLoaded(output: string): boolean {
  const sanitized = stripTerminalControlSequences(output);
  return (
    MODEL_PICKER_READY_MARKERS.every((marker) => sanitized.includes(marker)) &&
    MODEL_PICKER_FOOTER_MARKERS.some((marker) => sanitized.includes(marker))
  );
}

export const probeCopilotModelCatalog = Effect.fn("probeCopilotModelCatalog")(function* (
  settings: CopilotModelCatalogProbeSettings,
) {
  const pty = yield* PtyAdapter;
  const execution = resolveCommandExecution({
    command: settings.binaryPath,
    args: ["--no-color", "--screen-reader", "--no-custom-instructions", "-i", "/model"],
    wsl: {
      enabled: settings.useWsl,
      distro: settings.wslDistro,
      shellProfile: true,
    },
  });

  const spawned = yield* pty.spawn({
    shell: execution.command,
    args: [...execution.args],
    cwd: execution.cwd ?? globalThis.process.cwd(),
    cols: 160,
    rows: 48,
    env: {
      ...globalThis.process.env,
      ...execution.env,
    },
  });

  return yield* Effect.promise<ReadonlyArray<CopilotModelCatalogEntry>>(
    () =>
      new Promise((resolve, reject) => {
        let settled = false;
        let output = "";

        const cleanup = () => {
          unsubscribeData();
          unsubscribeExit();
        };

        const finish = (handler: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          spawned.kill();
          handler();
        };

        const maybeFinishFromOutput = () => {
          if (!hasModelPickerLoaded(output)) {
            return;
          }

          const parsed = parseCopilotModelPickerOutput(output);
          if (parsed.length > 0) {
            finish(() => resolve(parsed));
          }
        };

        const unsubscribeData = spawned.onData((chunk) => {
          output += chunk;
          maybeFinishFromOutput();
        });

        const unsubscribeExit = spawned.onExit((event) => {
          const parsed = parseCopilotModelPickerOutput(output);
          if (parsed.length > 0) {
            finish(() => resolve(parsed));
            return;
          }

          const exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
          finish(() =>
            reject(
              new Error(
                exitCode === null
                  ? "Copilot model picker exited before a model catalog was captured."
                  : `Copilot model picker exited with code ${exitCode} before a model catalog was captured.`,
              ),
            ),
          );
        });
      }),
  );
});
