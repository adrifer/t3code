export interface WslExecutionTarget {
  readonly distro?: string | undefined;
  readonly linuxCwd?: string | undefined;
}

export interface CommandExecutionInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly shellOnWindows?: boolean;
  readonly wsl?:
    | {
        readonly enabled?: boolean | undefined;
        readonly distro?: string | undefined;
        readonly shellProfile?: boolean | undefined;
      }
    | undefined;
}

export interface ResolvedCommandExecution {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly shell: boolean;
  readonly wsl: WslExecutionTarget | null;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

const WSL_PROFILE_BOOTSTRAP =
  'for file in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.bashrc"; do if [ -f "$file" ]; then . "$file" >/dev/null 2>&1 || true; fi; done; exec "$@"';

function shouldUseWslShellProfile(input: CommandExecutionInput): boolean {
  return input.wsl?.shellProfile === true && !/[\\/]/.test(input.command);
}

export function parseWslUncPath(
  input: string,
): { readonly distro: string; readonly linuxPath: string } | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const normalized = trimmed.replaceAll("/", "\\");
  const match = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/i.exec(normalized);
  if (!match) return null;

  const distro = normalizeOptionalString(match[1]);
  if (!distro) return null;

  const remainder = match[2]
    ?.split("\\")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return {
    distro,
    linuxPath: remainder && remainder.length > 0 ? `/${remainder.join("/")}` : "/",
  };
}

export function toWslPath(input: string): string | null {
  const unc = parseWslUncPath(input);
  if (unc) return unc.linuxPath;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("/")) {
    return toPosixPath(trimmed);
  }

  const driveMatch = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(trimmed);
  if (!driveMatch) return null;

  const drive = driveMatch[1]!.toLowerCase();
  const remainder = driveMatch[2] ? toPosixPath(driveMatch[2]) : "";
  return remainder.length > 0 ? `/mnt/${drive}/${remainder}` : `/mnt/${drive}`;
}

export function resolveWslExecutionTarget(input: {
  readonly cwd?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly distro?: string | undefined;
}): WslExecutionTarget | null {
  if (process.platform !== "win32") {
    return null;
  }

  const unc = input.cwd ? parseWslUncPath(input.cwd) : null;
  if (unc) {
    return {
      distro: unc.distro,
      linuxCwd: unc.linuxPath,
    };
  }

  if (!input.enabled) {
    return null;
  }

  return {
    distro: normalizeOptionalString(input.distro),
    linuxCwd: input.cwd ? (toWslPath(input.cwd) ?? undefined) : undefined,
  };
}

export function translatePathForExecution(
  targetPath: string,
  executionTarget: WslExecutionTarget | null,
): string {
  if (!executionTarget) {
    return targetPath;
  }

  return toWslPath(targetPath) ?? targetPath;
}

export function resolveCommandExecution(input: CommandExecutionInput): ResolvedCommandExecution {
  const shellOnWindows = input.shellOnWindows ?? true;
  const wslTarget = resolveWslExecutionTarget({
    cwd: input.cwd,
    enabled: input.wsl?.enabled,
    distro: input.wsl?.distro,
  });

  if (!wslTarget) {
    return {
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
      env: input.env,
      shell: process.platform === "win32" && shellOnWindows,
      wsl: null,
    };
  }

  return {
    command: "wsl.exe",
    args: [
      ...(wslTarget.distro ? ["-d", wslTarget.distro] : []),
      ...(wslTarget.linuxCwd ? ["--cd", wslTarget.linuxCwd] : []),
      "--exec",
      ...(shouldUseWslShellProfile(input)
        ? ["/bin/bash", "-lc", WSL_PROFILE_BOOTSTRAP, "bash", input.command, ...input.args]
        : [input.command, ...input.args]),
    ],
    env: input.env,
    shell: false,
    wsl: wslTarget,
  };
}
