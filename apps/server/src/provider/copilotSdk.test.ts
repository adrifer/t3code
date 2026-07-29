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
      runtime: { platform: "linux", arch: "x64" },
    });

    expect(clientOptions.cliPath).toContain(
      `${NodePath.sep}.cache${NodePath.sep}t3code${NodePath.sep}copilot${NodePath.sep}`,
    );
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

      expect(
        resolveBundledCopilotCliPath(
          {
            platform: "win32",
            arch: "x64",
            stagingRoot: root,
          },
          NodeURL.pathToFileURL(packedModule).href,
        ),
      ).toBe(unpackedLoader);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies the Linux CLI to a native filesystem before launching it", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-copilot-linux-"));
    try {
      const modulePath = NodePath.join(root, "app/apps/server/dist/bin.mjs");
      const packageRoot = NodePath.join(root, "app/node_modules/@github");
      const loaderPath = NodePath.join(packageRoot, "copilot/npm-loader.js");
      const nativeCliPath = NodePath.join(packageRoot, "copilot-linux-x64/copilot");
      NodeFS.mkdirSync(NodePath.dirname(modulePath), { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(loaderPath), { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(nativeCliPath), { recursive: true });
      NodeFS.writeFileSync(modulePath, "");
      NodeFS.writeFileSync(loaderPath, "");
      NodeFS.writeFileSync(nativeCliPath, "linux copilot");
      NodeFS.writeFileSync(
        NodePath.join(NodePath.dirname(loaderPath), "package.json"),
        JSON.stringify({ name: "@github/copilot" }),
      );
      NodeFS.writeFileSync(
        NodePath.join(NodePath.dirname(nativeCliPath), "package.json"),
        JSON.stringify({
          name: "@github/copilot-linux-x64",
          exports: { ".": "./copilot" },
        }),
      );

      const resolved = resolveBundledCopilotCliPath(
        {
          platform: "linux",
          arch: "x64",
          stagingRoot: NodePath.join(root, "tmp"),
        },
        NodeURL.pathToFileURL(modulePath).href,
      );

      expect(resolved).not.toBe(nativeCliPath);
      expect(NodeFS.readFileSync(resolved, "utf8")).toBe("linux copilot");
      expect(NodeFS.statSync(resolved).mode & 0o777).toBe(0o755);
      expect(resolved).toContain(`${NodePath.sep}t3code${NodePath.sep}copilot${NodePath.sep}`);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the unpacked loader for unsupported Linux architectures", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-copilot-linux-arch-"));
    try {
      const modulePath = NodePath.join(root, "app/apps/server/dist/bin.mjs");
      const loaderPath = NodePath.join(root, "app/node_modules/@github/copilot/npm-loader.js");
      NodeFS.mkdirSync(NodePath.dirname(modulePath), { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(loaderPath), { recursive: true });
      NodeFS.writeFileSync(modulePath, "");
      NodeFS.writeFileSync(loaderPath, "");
      NodeFS.writeFileSync(
        NodePath.join(NodePath.dirname(loaderPath), "package.json"),
        JSON.stringify({ name: "@github/copilot" }),
      );

      expect(
        resolveBundledCopilotCliPath(
          {
            platform: "linux",
            arch: "riscv64",
            stagingRoot: NodePath.join(root, "tmp"),
          },
          NodeURL.pathToFileURL(modulePath).href,
        ),
      ).toBe(loaderPath);
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
        runtime: { platform: "linux", arch: "x64" },
      });

      expect(clientOptions.cliPath).toBe(installedCopilot);
    } finally {
      NodeFS.rmSync(missingBin, { recursive: true, force: true });
      NodeFS.rmSync(installedBin, { recursive: true, force: true });
    }
  });
});
