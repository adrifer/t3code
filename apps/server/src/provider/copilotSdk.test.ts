// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { CopilotSettings } from "@t3tools/contracts";

import { buildCopilotSdkClientLaunch } from "./copilotSdk.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

describe("copilotSdk", () => {
  it("resolves the Copilot CLI from the first executable PATH match", () => {
    const missingBin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-copilot-missing-"));
    const installedBin = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-copilot-installed-"),
    );
    try {
      const installedCopilot = NodePath.join(installedBin, "copilot");
      NodeFS.writeFileSync(installedCopilot, "#!/bin/sh\nexit 0\n");
      NodeFS.chmodSync(installedCopilot, 0o755);

      const { clientOptions } = buildCopilotSdkClientLaunch({
        settings: decodeCopilotSettings({ binaryPath: "copilot" }),
        env: {
          PATH: [missingBin, installedBin].join(NodePath.delimiter),
        },
      });

      expect(clientOptions.cliPath).toBe(installedCopilot);
    } finally {
      NodeFS.rmSync(missingBin, { recursive: true, force: true });
      NodeFS.rmSync(installedBin, { recursive: true, force: true });
    }
  });
});
