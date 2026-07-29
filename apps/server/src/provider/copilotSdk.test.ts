// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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
        runtime: { platform: "linux", arch: "x64" },
      });

      expect(clientOptions.connection).toBeUndefined();
    } finally {
      NodeFS.rmSync(installedBin, { recursive: true, force: true });
    }
  });

  it("uses the unpacked SDK-matched native runtime on Windows", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-copilot-win32-"));
    try {
      const packedModule = NodePath.join(root, "app.asar", "apps/server/dist/bin.mjs");
      const packedModules = NodePath.join(root, "app.asar", "node_modules/@github");
      const unpackedCli = NodePath.join(
        root,
        "app.asar.unpacked",
        "node_modules/@github/copilot-win32-x64/copilot.exe",
      );
      NodeFS.mkdirSync(NodePath.dirname(packedModule), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(packedModules, "copilot-sdk"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(packedModules, "copilot"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(packedModules, "copilot-win32-x64"), { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(unpackedCli), { recursive: true });
      NodeFS.writeFileSync(packedModule, "");
      NodeFS.writeFileSync(NodePath.join(packedModules, "copilot-sdk/index.js"), "");
      NodeFS.writeFileSync(
        NodePath.join(packedModules, "copilot-sdk/package.json"),
        JSON.stringify({
          name: "@github/copilot-sdk",
          exports: { ".": "./index.js" },
        }),
      );
      NodeFS.writeFileSync(NodePath.join(packedModules, "copilot/npm-loader.js"), "");
      NodeFS.writeFileSync(
        NodePath.join(packedModules, "copilot-win32-x64/package.json"),
        JSON.stringify({
          name: "@github/copilot-win32-x64",
          exports: { ".": "./copilot.exe" },
        }),
      );
      NodeFS.writeFileSync(NodePath.join(packedModules, "copilot-win32-x64/copilot.exe"), "");
      NodeFS.writeFileSync(unpackedCli, "");

      const { clientOptions } = buildCopilotSdkClientLaunch({
        settings: decodeCopilotSettings({ binaryPath: "copilot" }),
        runtime: { platform: "win32", arch: "x64" },
        moduleUrl: NodeURL.pathToFileURL(packedModule).href,
      });

      expect(clientOptions.connection).toEqual({
        kind: "stdio",
        path: unpackedCli,
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
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
        runtime: { platform: "linux", arch: "x64" },
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
