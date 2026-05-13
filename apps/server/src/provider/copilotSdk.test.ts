// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import * as Schema from "effect/Schema";
import { CopilotSettings } from "@t3tools/contracts";

import { buildCopilotSdkClientLaunch } from "./copilotSdk.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

describe("copilotSdk", () => {
  it("resolves the Copilot CLI from the first executable PATH match", () => {
    const missingBin = mkdtempSync(join(tmpdir(), "t3-copilot-missing-"));
    const installedBin = mkdtempSync(join(tmpdir(), "t3-copilot-installed-"));
    try {
      const installedCopilot = join(installedBin, "copilot");
      writeFileSync(installedCopilot, "#!/bin/sh\nexit 0\n");
      chmodSync(installedCopilot, 0o755);

      const { clientOptions } = buildCopilotSdkClientLaunch({
        settings: decodeCopilotSettings({ binaryPath: "copilot" }),
        env: {
          PATH: [missingBin, installedBin].join(delimiter),
        },
      });

      expect(clientOptions.cliPath).toBe(installedCopilot);
    } finally {
      rmSync(missingBin, { recursive: true, force: true });
      rmSync(installedBin, { recursive: true, force: true });
    }
  });
});
