import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding legacy snapshots", () => {
    const parsed = decodeServerProvider({
      provider: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
  });

  it("decodes provider slash command actions and quota snapshots", () => {
    const parsed = decodeServerProvider({
      provider: "copilot",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      slashCommands: [
        {
          name: "remote",
          description: "Toggle GitHub.com continuation",
          action: "copilot.remote.toggle",
        },
      ],
      quota: {
        premium_interactions: {
          entitlementRequests: 300,
          usedRequests: 25,
          remainingPercentage: 91.6,
          overage: 0,
          overageAllowedWithExhaustedQuota: false,
          resetDate: "2026-05-01T00:00:00Z",
        },
      },
    });

    expect(parsed.slashCommands).toEqual([
      {
        name: "remote",
        description: "Toggle GitHub.com continuation",
        action: "copilot.remote.toggle",
      },
    ]);
    expect(parsed.quota?.premium_interactions?.usedRequests).toBe(25);
  });
});
