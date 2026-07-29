// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { CopilotSettings } from "@t3tools/contracts";

import { buildCopilotSdkClientLaunch, resolveBundledCopilotCliPath } from "./copilotSdk.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

describe("copilotSdk", () => {
  it("uses the bundled CLI loader when the default command is not installed", () => {
    const { clientOptions } = buildCopilotSdkClientLaunch({
      settings: decodeCopilotSettings({ binaryPath: "copilot" }),
      env: { PATH: "" },
    });

    expect(clientOptions.cliPath).toMatch(/@github[/\\]copilot[/\\]npm-loader\.js$/);
  });

  it("uses the unpacked bundled CLI loader in packaged Electron apps", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-copilot-asar-"));
    try {
      const packedModule = NodePath.join(root, "app.asar", "apps/server/dist/bin.mjs");
      const packedLoader = NodePath.join(
        root,
        "app.asar",
        "node_modules/@github/copilot/npm-loader.js",
      );
      const unpackedLoader = NodePath.join(
        root,
        "app.asar.unpacked",
        "node_modules/@github/copilot/npm-loader.js",
      );
      NodeFS.mkdirSync(NodePath.dirname(packedModule), { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(packedLoader), { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(unpackedLoader), { recursive: true });
      NodeFS.writeFileSync(packedModule, "");
      NodeFS.writeFileSync(packedLoader, "");
      NodeFS.writeFileSync(unpackedLoader, "");
      NodeFS.writeFileSync(
        NodePath.join(NodePath.dirname(packedLoader), "package.json"),
        JSON.stringify({ name: "@github/copilot" }),
      );

      expect(resolveBundledCopilotCliPath(NodeURL.pathToFileURL(packedModule).href)).toBe(
        unpackedLoader,
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

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
