import type {
  CopilotSettings,
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { Effect, Equal, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { CopilotProvider } from "../Services/CopilotProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "@t3tools/contracts";
import { resolveCommandExecution } from "../../wsl.ts";

const PROVIDER = "copilot" as const;
const COPILOT_AUTH_TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

const COPILOT_REASONING_LEVELS = [
  { value: "xhigh", label: "Extra High" },
  { value: "high", label: "High", isDefault: true },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const;

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [...COPILOT_REASONING_LEVELS],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [...COPILOT_REASONING_LEVELS],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [...COPILOT_REASONING_LEVELS],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [...COPILOT_REASONING_LEVELS],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [...COPILOT_REASONING_LEVELS],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [...COPILOT_REASONING_LEVELS],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
];

export function getCopilotModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ?? {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    }
  );
}

function copilotVersionCommand(settings: CopilotSettings) {
  const execution = resolveCommandExecution({
    command: settings.binaryPath,
    args: ["--version"],
    wsl: {
      enabled: settings.useWsl,
      distro: settings.wslDistro,
      shellProfile: true,
    },
  });

  return ChildProcess.make(execution.command, [...execution.args], {
    shell: execution.shell,
  });
}

function copilotGhAuthStatusCommand(settings: CopilotSettings) {
  const execution = resolveCommandExecution({
    command: "gh",
    args: ["auth", "status"],
    wsl: {
      enabled: settings.useWsl,
      distro: settings.wslDistro,
      shellProfile: true,
    },
  });

  return ChildProcess.make(execution.command, [...execution.args], {
    shell: execution.shell,
  });
}

type CopilotAuthProbe = {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
};

function parseCopilotAuthStatusFromEnvironment(): CopilotAuthProbe | null {
  if (nonEmptyTrimmed(process.env.COPILOT_PROVIDER_BASE_URL)) {
    return {
      status: "ready",
      auth: {
        status: "unknown",
      },
      message: "Using a custom Copilot model provider; GitHub login check skipped.",
    };
  }

  for (const variable of COPILOT_AUTH_TOKEN_ENV_VARS) {
    if (typeof process.env[variable] === "string" && process.env[variable]!.trim().length > 0) {
      return {
        status: "ready",
        auth: {
          status: "authenticated",
          type: "token",
          label: variable,
        },
      };
    }
  }

  return null;
}

const probeCopilotAuthStatus = Effect.fn("probeCopilotAuthStatus")(function* (
  settings: CopilotSettings,
) {
  const environmentAuth = parseCopilotAuthStatusFromEnvironment();
  if (environmentAuth) {
    return environmentAuth;
  }

  const ghAuthProbe = yield* spawnAndCollect("gh", copilotGhAuthStatusCommand(settings)).pipe(
    Effect.map((result): CopilotAuthProbe | null =>
      result.code === 0
        ? {
            status: "ready",
            auth: {
              status: "authenticated",
              type: "oauth",
              label: "GitHub CLI",
            },
          }
        : null,
    ),
    Effect.catch(() => Effect.succeed(null)),
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
  );

  if (Option.isSome(ghAuthProbe) && ghAuthProbe.value) {
    return ghAuthProbe.value;
  }

  return {
    status: "ready",
    auth: {
      status: "unknown",
    },
  } satisfies CopilotAuthProbe;
});

export const checkCopilotProviderStatus = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const copilotSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.copilot),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "settings.json",
          detail: "failed to load Copilot settings",
          cause,
        }),
    ),
  );

  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    copilotSettings.customModels,
  );
  const authProbe = yield* probeCopilotAuthStatus(copilotSettings);

  const versionResult = yield* spawnAndCollect(
    copilotSettings.binaryPath,
    copilotVersionCommand(copilotSettings),
  ).pipe(
    Effect.mapError((cause) => {
      if (isCommandMissingCause(cause)) {
        return cause;
      }
      return new ServerSettingsError({
        settingsPath: "settings.json",
        detail: "failed to probe GitHub Copilot CLI",
        cause,
      });
    }),
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
  );

  if (Option.isNone(versionResult)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: authProbe.auth,
        message: "Timed out while checking GitHub Copilot CLI version.",
      },
    });
  }

  const result = versionResult.value;
  const versionText = `${result.stdout}\n${result.stderr}`.trim();
  const version = parseGenericCliVersion(versionText) ?? (versionText || null);

  return buildServerProvider({
    provider: PROVIDER,
    enabled: copilotSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: result.code === 0 ? authProbe.status : "warning",
      auth: authProbe.auth,
      ...(result.code === 0
        ? authProbe.message
          ? { message: authProbe.message }
          : {}
        : {
            message:
              detailFromResult(result) ?? "GitHub Copilot CLI exited unexpectedly while probing.",
          }),
    },
  });
}).pipe(
  Effect.catch((cause) => {
    if (isCommandMissingCause(cause)) {
      return Effect.gen(function* () {
        const settingsService = yield* ServerSettingsService;
        const copilotSettings = yield* settingsService.getSettings.pipe(
          Effect.map((settings) => settings.providers.copilot),
          Effect.mapError(
            (nestedCause) =>
              new ServerSettingsError({
                settingsPath: "settings.json",
                detail: "failed to load Copilot settings",
                cause: nestedCause,
              }),
          ),
        );
        return buildServerProvider({
          provider: PROVIDER,
          enabled: copilotSettings.enabled,
          checkedAt: new Date().toISOString(),
          models: providerModelsFromSettings(
            BUILT_IN_MODELS,
            PROVIDER,
            copilotSettings.customModels,
          ),
          probe: {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message:
              "GitHub Copilot CLI is not installed or is not on PATH. Install it or set a custom binary path.",
          },
        });
      });
    }

    return Effect.fail(
      new ServerSettingsError({
        settingsPath: "settings.json",
        detail: "failed to probe GitHub Copilot CLI",
        cause,
      }),
    );
  }),
);

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkCopilotProviderStatus.pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
