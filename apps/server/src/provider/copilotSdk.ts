// @effect-diagnostics nodeBuiltinImport:off
import {
  CopilotSettings,
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  type CopilotClientOptions,
  type GetAuthStatusResponse,
  type ModelInfo,
} from "@github/copilot-sdk";
import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";
import { accessSync, constants, existsSync } from "node:fs";
import * as path from "node:path";

import {
  resolveCommandExecution,
  resolveWslExecutionTarget,
  translatePathForExecution,
  type WslExecutionTarget,
} from "../wsl.ts";

const COPILOT_REASONING_LEVELS = [
  { id: "xhigh", label: "Extra High" },
  { id: "high", label: "High", isDefault: true },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
] as const;

export const COPILOT_DEFAULT_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [...COPILOT_REASONING_LEVELS],
      currentValue: "high",
    },
  ],
}) satisfies ModelCapabilities;

export const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
}) satisfies ModelCapabilities;

function hasKnownCopilotCapabilities(slug: string | null | undefined): boolean {
  return typeof slug === "string" && /^(?:gpt-|claude-|goldeneye$)/.test(slug.trim());
}

function toReasoningEffortLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return value;
  }
}

function resolvePathVariable(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of ["PATH", "Path", "path"] as const) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const raw = env.PATHEXT;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [".exe", ".cmd", ".bat", ".com"];
  }

  const seen = new Set<string>();
  const extensions: string[] = [];
  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const normalized = trimmed.startsWith(".")
      ? trimmed.toLowerCase()
      : `.${trimmed.toLowerCase()}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    extensions.push(normalized);
  }
  return extensions.length > 0 ? extensions : [".exe", ".cmd", ".bat", ".com"];
}

function isExecutablePath(filePath: string): boolean {
  if (process.platform === "win32") {
    return existsSync(filePath);
  }

  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return isExecutablePath(trimmed) ? trimmed : undefined;
  }

  const pathValue = resolvePathVariable(env);
  if (!pathValue) {
    return undefined;
  }

  const windowsExtensions =
    process.platform === "win32"
      ? resolveWindowsPathExtensions(env)
      : ([] as ReadonlyArray<string>);
  const hasKnownWindowsExtension =
    process.platform === "win32" &&
    windowsExtensions.some((extension) => trimmed.toLowerCase().endsWith(extension));
  const commandCandidates =
    process.platform === "win32" && !hasKnownWindowsExtension
      ? windowsExtensions.map((extension) => `${trimmed}${extension}`)
      : [trimmed];

  for (const entry of pathValue.split(path.delimiter)) {
    const normalizedEntry = entry.trim();
    if (!normalizedEntry) continue;
    for (const commandCandidate of commandCandidates) {
      const resolved = path.join(normalizedEntry, commandCandidate);
      if (isExecutablePath(resolved)) {
        return resolved;
      }
    }
  }

  return undefined;
}

function isDefaultCopilotBinaryPath(binaryPath: string): boolean {
  const normalized = binaryPath.trim().toLowerCase();
  return normalized === "copilot" || normalized === "copilot.exe" || normalized === "copilot.cmd";
}

function resolveSdkCliPath(
  command: string,
  fallbackToBundledCopilot: boolean,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  const resolved = resolveCommandOnPath(command, env);
  if (resolved) {
    return resolved;
  }
  if (fallbackToBundledCopilot) {
    return undefined;
  }
  throw new Error(`Command not found: ${command}`);
}

export function getCopilotModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return hasKnownCopilotCapabilities(slug)
    ? COPILOT_DEFAULT_MODEL_CAPABILITIES
    : EMPTY_MODEL_CAPABILITIES;
}

function buildReasoningCapabilities(model: ModelInfo): ModelCapabilities | null {
  const supportedReasoningEfforts = model.supportedReasoningEfforts ?? [];
  if (supportedReasoningEfforts.length === 0) {
    return null;
  }

  return {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: supportedReasoningEfforts.map((value) => {
          if (model.defaultReasoningEffort === value) {
            return {
              id: value,
              label: toReasoningEffortLabel(value),
              isDefault: true,
            };
          }
          return {
            id: value,
            label: toReasoningEffortLabel(value),
          };
        }),
        ...(model.defaultReasoningEffort ? { currentValue: model.defaultReasoningEffort } : {}),
      },
    ],
  };
}

export function buildCopilotSdkProviderModel(model: ModelInfo): ServerProviderModel | null {
  const slug = normalizeModelSlug(model.id, ProviderDriverKind.make("copilot"));
  if (!slug) {
    return null;
  }

  return {
    slug,
    name: model.name,
    isCustom: false,
    ...(formatPremiumRequestMultiplier(model.billing?.multiplier)
      ? { premiumRequestMultiplier: formatPremiumRequestMultiplier(model.billing?.multiplier) }
      : {}),
    capabilities: buildReasoningCapabilities(model) ?? getCopilotModelCapabilities(slug),
  };
}

export function buildCopilotSdkProviderModels(
  models: ReadonlyArray<ModelInfo> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!models || models.length === 0) {
    return [];
  }

  const entries: ServerProviderModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const entry = buildCopilotSdkProviderModel(model);
    if (!entry || seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    entries.push(entry);
  }
  return entries;
}

export function formatPremiumRequestMultiplier(
  multiplier: number | null | undefined,
): string | undefined {
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) {
    return undefined;
  }

  const rounded = Math.round(multiplier * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}x`;
}

export function translateCopilotWorkingDirectory(
  cwd: string | undefined,
  executionTarget: WslExecutionTarget | null,
): string | undefined {
  if (!cwd) {
    return undefined;
  }
  return translatePathForExecution(cwd, executionTarget);
}

export function buildCopilotSdkClientLaunch(input: {
  readonly settings: CopilotSettings;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): {
  readonly clientOptions: CopilotClientOptions;
  readonly executionTarget: WslExecutionTarget | null;
} {
  const execution = resolveCommandExecution({
    command: input.settings.binaryPath,
    args: [],
    cwd: input.cwd,
    env: input.env,
    shellOnWindows: false,
    wsl: {
      enabled: input.settings.useWsl,
      distro: input.settings.wslDistro,
      shellProfile: true,
    },
  });

  const cliPath = resolveSdkCliPath(
    execution.command,
    !execution.wsl && isDefaultCopilotBinaryPath(input.settings.binaryPath),
    execution.env,
  );

  return {
    clientOptions: {
      ...(cliPath ? { cliPath } : {}),
      ...(execution.args.length > 0 ? { cliArgs: [...execution.args] } : {}),
      ...(execution.cwd ? { cwd: execution.cwd } : {}),
      ...(execution.env ? { env: execution.env } : {}),
    },
    executionTarget: execution.wsl,
  };
}

export function resolveCopilotExecutionTarget(
  settings: Pick<CopilotSettings, "useWsl" | "wslDistro">,
  cwd?: string | undefined,
): WslExecutionTarget | null {
  return resolveWslExecutionTarget({
    cwd,
    enabled: settings.useWsl,
    distro: settings.wslDistro,
  });
}

function authTypeLabel(authType: GetAuthStatusResponse["authType"]): string | undefined {
  switch (authType) {
    case "gh-cli":
      return "GitHub CLI";
    case "api-key":
      return "API key";
    case "token":
      return "Token";
    case "user":
      return "GitHub";
    case "env":
      return "Environment";
    case "hmac":
      return "HMAC";
    default:
      return undefined;
  }
}

export function buildCopilotSdkAuth(authStatus: GetAuthStatusResponse): ServerProviderAuth {
  if (!authStatus.isAuthenticated) {
    return { status: "unauthenticated" };
  }

  return {
    status: "authenticated",
    ...(authStatus.authType ? { type: authStatus.authType } : {}),
    ...(authStatus.login
      ? { label: authStatus.login }
      : authTypeLabel(authStatus.authType)
        ? { label: authTypeLabel(authStatus.authType) }
        : {}),
  };
}
