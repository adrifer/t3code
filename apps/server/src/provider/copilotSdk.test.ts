// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { CopilotSettings } from "@t3tools/contracts";

import { buildCopilotSdkClientLaunch } from "./copilotSdk.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

describe("copilotSdk", () => {
  it("uses the SDK bundled runtime instead of a PATH-installed default command", () => {
    const installedBin = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-copilot-installed-"),
    );
    try {
      const installedCopilot = NodePath.join(installedBin, "copilot");
      NodeFS.writeFileSync(installedCopilot, "#!/bin/sh\nexit 0\n");
      NodeFS.chmodSync(installedCopilot, 0o755);

      const { clientOptions } = buildCopilotSdkClientLaunch({
        settings: decodeCopilotSettings({ binaryPath: "copilot" }),
        env: { PATH: installedBin },
      });

      expect(clientOptions.connection).toBeUndefined();
    } finally {
      NodeFS.rmSync(installedBin, { recursive: true, force: true });
    }
  });

  it("uses an explicitly configured Copilot CLI command", () => {
    const installedBin = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-copilot-installed-"),
    );
    try {
      const installedCopilot = NodePath.join(installedBin, "custom-copilot");
      NodeFS.writeFileSync(installedCopilot, "#!/bin/sh\nexit 0\n");
      NodeFS.chmodSync(installedCopilot, 0o755);

      const { clientOptions } = buildCopilotSdkClientLaunch({
        settings: decodeCopilotSettings({ binaryPath: "custom-copilot" }),
        env: { PATH: installedBin },
      });

      expect(clientOptions.connection).toEqual({
        kind: "stdio",
        path: installedCopilot,
      });
    } finally {
      NodeFS.rmSync(installedBin, { recursive: true, force: true });
    }
  });
});
