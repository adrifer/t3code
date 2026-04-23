import type {
  CopilotSettings,
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { Cache, Duration, Effect, Equal, Layer, Option, Stream } from "effect";
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
} from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { CopilotProvider } from "../Services/CopilotProvider.ts";
import {
  FALLBACK_COPILOT_MODEL_CATALOG,
  probeCopilotModelCatalog,
  type CopilotModelCatalogEntry,
  type CopilotModelCatalogProbeSettings,
} from "../copilotModelCatalog.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerSettingsError } from "@t3tools/contracts";
import { PtyAdapter } from "../../terminal/Services/PTY.ts";
import { resolveCommandExecution } from "../../wsl.ts";

const PROVIDER = "copilot" as const;
const COPILOT_AUTH_TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

const COPILOT_REASONING_LEVELS = [
  { value: "xhigh", label: "Extra High" },
  { value: "high", label: "High", isDefault: true },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const;

const COPILOT_DEFAULT_MODEL_CAPABILITIES = {
  reasoningEffortLevels: [...COPILOT_REASONING_LEVELS],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
} satisfies ModelCapabilities;

const EMPTY_MODEL_CAPABILITIES = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
} satisfies ModelCapabilities;

function hasKnownCopilotCapabilities(slug: string | null | undefined): boolean {
  return typeof slug === "string" && /^(?:gpt-|claude-|goldeneye$)/.test(slug.trim());
}

function buildCopilotProviderModel(entry: CopilotModelCatalogEntry): ServerProviderModel {
  return {
    slug: entry.slug,
    name: entry.name,
    isCustom: false,
    ...(entry.premiumRequestMultiplier
      ? { premiumRequestMultiplier: entry.premiumRequestMultiplier }
      : {}),
    capabilities: getCopilotModelCapabilities(entry.slug),
  };
}

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> =
  FALLBACK_COPILOT_MODEL_CATALOG.map(buildCopilotProviderModel);

export function getCopilotModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return hasKnownCopilotCapabilities(slug)
    ? COPILOT_DEFAULT_MODEL_CAPABILITIES
    : EMPTY_MODEL_CAPABILITIES;
}

function modelCatalogProbeSettings(settings: CopilotSettings): CopilotModelCatalogProbeSettings {
  return {
    binaryPath: settings.binaryPath,
    useWsl: settings.useWsl,
    wslDistro: settings.wslDistro,
  };
}

function providerModelsFromCatalog(
  catalog: ReadonlyArray<CopilotModelCatalogEntry> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  return catalog && catalog.length > 0 ? catalog.map(buildCopilotProviderModel) : BUILT_IN_MODELS;
}

function createInitialCopilotProviderSnapshot(settings: CopilotSettings) {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    settings.customModels,
    COPILOT_DEFAULT_MODEL_CAPABILITIES,
  );

  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot CLI availability...",
    },
  });
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

export const checkCopilotProviderStatus = (
  getModelCatalog: (
    settings: CopilotModelCatalogProbeSettings,
  ) => Effect.Effect<ReadonlyArray<CopilotModelCatalogEntry> | null, never> = () =>
    Effect.succeed(null),
) =>
  Effect.gen(function* () {
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
    const modelCatalog = yield* getModelCatalog(modelCatalogProbeSettings(copilotSettings));
    const models = providerModelsFromSettings(
      providerModelsFromCatalog(modelCatalog),
      PROVIDER,
      copilotSettings.customModels,
      COPILOT_DEFAULT_MODEL_CAPABILITIES,
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
              COPILOT_DEFAULT_MODEL_CAPABILITIES,
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
    const ptyOption = yield* Effect.serviceOption(PtyAdapter);
    const modelCatalogCache = yield* Cache.make({
      capacity: 4,
      timeToLive: Duration.minutes(10),
      lookup: (key: string) => {
        const settings = JSON.parse(key) as CopilotModelCatalogProbeSettings;
        return Option.match(ptyOption, {
          onSome: (pty) =>
            probeCopilotModelCatalog(settings).pipe(
              Effect.provideService(PtyAdapter, pty),
              Effect.timeoutOption("10 seconds"),
              Effect.map((option) => (Option.isSome(option) ? option.value : null)),
              Effect.catch(() => Effect.succeed(null)),
            ),
          onNone: () => Effect.succeed(null),
        });
      },
    });
    const checkProvider = checkCopilotProviderStatus((settings) =>
      Cache.get(modelCatalogCache, JSON.stringify(settings)),
    ).pipe(
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
      initialSnapshot: createInitialCopilotProviderSnapshot,
      checkProvider,
    });
  }),
);
