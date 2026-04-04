import { afterEach, describe, expect, it } from "vitest";

import {
  parseWslUncPath,
  resolveCommandExecution,
  resolveWslInteractiveShellExecution,
  resolveWslExecutionTarget,
  toWslPath,
  translatePathForExecution,
} from "./wsl";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("wsl helpers", () => {
  it("parses WSL UNC workspace paths", () => {
    expect(parseWslUncPath(String.raw`\\wsl$\Ubuntu\home\dev\repo`)).toEqual({
      distro: "Ubuntu",
      linuxPath: "/home/dev/repo",
    });
    expect(parseWslUncPath(String.raw`\\wsl.localhost\Arch`)).toEqual({
      distro: "Arch",
      linuxPath: "/",
    });
  });

  it("translates Windows paths into WSL paths", () => {
    expect(toWslPath(String.raw`C:\Users\dev\project`)).toBe("/mnt/c/Users/dev/project");
    expect(toWslPath(String.raw`\\wsl$\Ubuntu\home\dev\repo`)).toBe("/home/dev/repo");
  });

  it("resolves WSL execution targets on Windows", () => {
    setPlatform("win32");
    expect(resolveWslExecutionTarget({ cwd: String.raw`\\wsl$\Ubuntu\home\dev\repo` })).toEqual({
      distro: "Ubuntu",
      linuxCwd: "/home/dev/repo",
    });
    expect(
      resolveWslExecutionTarget({
        cwd: String.raw`D:\work\repo`,
        enabled: true,
        distro: "Ubuntu",
      }),
    ).toEqual({
      distro: "Ubuntu",
      linuxCwd: "/mnt/d/work/repo",
    });
  });

  it("wraps commands through wsl.exe when needed", () => {
    setPlatform("win32");
    expect(
      resolveCommandExecution({
        command: "copilot",
        args: ["--version"],
        cwd: String.raw`\\wsl$\Ubuntu\home\dev\repo`,
      }),
    ).toMatchObject({
      command: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/home/dev/repo", "--exec", "copilot", "--version"],
      shell: false,
    });
    expect(
      translatePathForExecution(
        String.raw`C:\Users\dev\.t3\attachments\image.png`,
        resolveWslExecutionTarget({ enabled: true, distro: "Ubuntu" }),
      ),
    ).toBe("/mnt/c/Users/dev/.t3/attachments/image.png");
  });

  it("can bootstrap a WSL shell profile before resolving commands", () => {
    setPlatform("win32");
    expect(
      resolveCommandExecution({
        command: "copilot",
        args: ["--version"],
        cwd: String.raw`\\wsl$\Ubuntu\home\dev\repo`,
        wsl: {
          shellProfile: true,
        },
      }),
    ).toMatchObject({
      command: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/dev/repo",
        "--exec",
        "/bin/sh",
        "-lc",
        expect.stringContaining(".bashrc"),
        "sh",
        "copilot",
        "--version",
      ],
      shell: false,
    });
  });

  it("includes zsh startup files in the WSL shell bootstrap", () => {
    setPlatform("win32");
    expect(
      resolveCommandExecution({
        command: "copilot",
        args: ["--version"],
        cwd: String.raw`\\wsl$\Ubuntu\home\dev\repo`,
        wsl: {
          shellProfile: true,
        },
      }),
    ).toMatchObject({
      command: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/dev/repo",
        "--exec",
        "/bin/sh",
        "-lc",
        expect.stringContaining(".zshrc"),
        "sh",
        "copilot",
        "--version",
      ],
      shell: false,
    });
  });

  it("validates the detected WSL shell before using it", () => {
    setPlatform("win32");
    expect(
      resolveCommandExecution({
        command: "copilot",
        args: ["--version"],
        cwd: String.raw`\\wsl$\Ubuntu\home\dev\repo`,
        wsl: {
          shellProfile: true,
        },
      }),
    ).toMatchObject({
      command: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/dev/repo",
        "--exec",
        "/bin/sh",
        "-lc",
        expect.stringContaining('"$user_shell" -lc "exit 0"'),
        "sh",
        "copilot",
        "--version",
      ],
      shell: false,
    });
  });

  it("builds a safe interactive WSL shell bootstrap", () => {
    setPlatform("win32");
    expect(
      resolveWslInteractiveShellExecution({
        distro: "Ubuntu",
        linuxCwd: "/home/dev/repo",
      }),
    ).toMatchObject({
      command: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/dev/repo",
        "--exec",
        "/bin/sh",
        "-lc",
        expect.stringContaining('case "$shell_name" in'),
        "sh",
      ],
    });
  });

  it("can bootstrap WSL shell profiles for git commands too", () => {
    setPlatform("win32");
    expect(
      resolveCommandExecution({
        command: "git",
        args: ["status", "--short"],
        cwd: String.raw`\\wsl$\Ubuntu\home\dev\repo`,
        wsl: {
          shellProfile: true,
        },
      }),
    ).toMatchObject({
      command: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/dev/repo",
        "--exec",
        "/bin/sh",
        "-lc",
        expect.any(String),
        "sh",
        "git",
        "status",
        "--short",
      ],
      shell: false,
    });
  });
});
