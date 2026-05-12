import { CopilotClient, type GetAuthStatusResponse, type ModelInfo } from "@github/copilot-sdk";
import {
  CopilotSettings,
  ProviderDriverKind,
  ServerSettingsError,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  buildCopilotSdkAuth,
  buildCopilotSdkClientLaunch,
  buildCopilotSdkProviderModels,
  COPILOT_DEFAULT_MODEL_CAPABILITIES,
  getCopilotModelCapabilities,
} from "../copilotSdk.ts";
import {
  FALLBACK_COPILOT_MODEL_CATALOG,
  type CopilotModelCatalogEntry,
} from "../copilotModelCatalog.ts";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  nonEmptyTrimmed,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";

const PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: true,
} as const;
const COPILOT_AUTH_TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const SDK_STATUS_TIMEOUT = Duration.millis(DEFAULT_TIMEOUT_MS * 2);

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

export { getCopilotModelCapabilities } from "../copilotSdk.ts";

export function createInitialCopilotProviderSnapshot(settings: CopilotSettings) {
  const checkedAt = DateTime.formatIso(DateTime.nowUnsafe());
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    settings.customModels,
    COPILOT_DEFAULT_MODEL_CAPABILITIES,
  );

  if (!settings.enabled) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: COPILOT_PRESENTATION,
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
    driver: PROVIDER,
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot SDK availability...",
    },
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

function mapSdkAuthStatus(authStatus: GetAuthStatusResponse): CopilotAuthProbe {
  if (authStatus.isAuthenticated) {
    return {
      status: "ready",
      auth: buildCopilotSdkAuth(authStatus),
      ...(authStatus.statusMessage ? { message: authStatus.statusMessage } : {}),
    };
  }

  return {
    status: "warning",
    auth: buildCopilotSdkAuth(authStatus),
    ...(authStatus.statusMessage
      ? { message: authStatus.statusMessage }
      : { message: "Sign in to GitHub Copilot to use the provider." }),
  };
}

function providerModelsFromSdk(
  models: ReadonlyArray<ModelInfo> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const resolved = buildCopilotSdkProviderModels(models);
  return resolved.length > 0 ? resolved : BUILT_IN_MODELS;
}

function isCommandMissingError(cause: unknown): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }

  const lower = cause.message.toLowerCase();
  return lower.includes("command not found") || lower.includes("enoent");
}

async function stopCopilotClient(client: CopilotClient): Promise<void> {
  try {
    const cleanupErrors = await client.stop();
    if (cleanupErrors.length > 0) {
      await client.forceStop();
    }
  } catch {
    try {
      await client.forceStop();
    } catch {
      // ignore cleanup failures
    }
  }
}

const probeCopilotSdkStatus = Effect.fn("probeCopilotSdkStatus")(function* (
  settings: CopilotSettings,
) {
  const environmentAuth = parseCopilotAuthStatusFromEnvironment();

  const probe = Effect.tryPromise({
    try: async () => {
      const { clientOptions } = buildCopilotSdkClientLaunch({ settings });
      const client = new CopilotClient({
        ...clientOptions,
        logLevel: "error",
      });

      try {
        await client.start();
        const [status, authStatus, models] = await Promise.all([
          client.getStatus(),
          client.getAuthStatus().catch(() => null),
          client.listModels().catch(() => null),
          client.rpc.account.getQuota().catch(() => null),
        ]);

        return {
          version: status.version,
          authProbe: environmentAuth ?? (authStatus ? mapSdkAuthStatus(authStatus) : null),
          models,
        };
      } finally {
        await stopCopilotClient(client);
      }
    },
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "provider/status",
        detail: cause instanceof Error ? cause.message : "Failed to probe Copilot SDK",
        cause,
      }),
  }).pipe(Effect.timeoutOption(SDK_STATUS_TIMEOUT));

  const result = yield* probe;
  if (Option.isNone(result)) {
    return {
      installed: true,
      version: null,
      status: "warning" as const,
      auth: environmentAuth?.auth ?? ({ status: "unknown" } satisfies ServerProviderAuth),
      models: BUILT_IN_MODELS,
      message: "Timed out while checking GitHub Copilot SDK status.",
    };
  }

  return {
    installed: true,
    version: result.value.version ?? null,
    status: (result.value.authProbe?.status ?? "ready") as Exclude<ServerProviderState, "disabled">,
    auth: result.value.authProbe?.auth ?? ({ status: "unknown" } satisfies ServerProviderAuth),
    models: providerModelsFromSdk(result.value.models),
    ...(result.value.authProbe?.message ? { message: result.value.authProbe.message } : {}),
  };
});

export const checkCopilotProviderStatus = (copilotSettings: CopilotSettings) =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const defaultModels = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      copilotSettings.customModels,
      COPILOT_DEFAULT_MODEL_CAPABILITIES,
    );

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        driver: PROVIDER,
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models: defaultModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    const probe = yield* probeCopilotSdkStatus(copilotSettings).pipe(
      Effect.catch((cause) => {
        if (isCommandMissingError(cause)) {
          return Effect.succeed({
            installed: false,
            version: null,
            status: "error" as const,
            auth: { status: "unknown" } satisfies ServerProviderAuth,
            models: BUILT_IN_MODELS,
            message:
              "GitHub Copilot CLI is not installed or is not on PATH. Install it or set a custom binary path.",
          });
        }

        return Effect.fail(
          new ServerSettingsError({
            settingsPath: "settings.json",
            detail: "failed to probe GitHub Copilot SDK",
            cause,
          }),
        );
      }),
    );

    return buildServerProvider({
      driver: PROVIDER,
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        probe.models,
        PROVIDER,
        copilotSettings.customModels,
        COPILOT_DEFAULT_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: probe.installed,
        version: probe.version,
        status: probe.status,
        auth: probe.auth,
        ...(probe.message ? { message: probe.message } : {}),
      },
    });
  });
