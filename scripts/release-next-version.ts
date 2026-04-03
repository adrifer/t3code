import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stableReleaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface StableReleaseTag {
  readonly tag: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

interface ReleaseTagOptions {
  readonly rootDir: string | undefined;
  readonly remote: string;
}

export function parseStableReleaseTag(tag: string): StableReleaseTag | null {
  const match = stableReleaseTagPattern.exec(tag);
  if (!match) {
    return null;
  }

  return {
    tag,
    major: Number.parseInt(match[1] ?? "", 10),
    minor: Number.parseInt(match[2] ?? "", 10),
    patch: Number.parseInt(match[3] ?? "", 10),
  };
}

export function compareStableReleaseTags(left: StableReleaseTag, right: StableReleaseTag): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

export function findLatestStableReleaseTag(tags: Iterable<string>): StableReleaseTag | null {
  let latestTag: StableReleaseTag | null = null;

  for (const tag of tags) {
    const parsedTag = parseStableReleaseTag(tag);
    if (!parsedTag) {
      continue;
    }

    if (!latestTag || compareStableReleaseTags(parsedTag, latestTag) > 0) {
      latestTag = parsedTag;
    }
  }

  return latestTag;
}

export function deriveNextReleaseTag(latestTag: StableReleaseTag | null): string {
  if (!latestTag) {
    return "v0.0.1";
  }

  return `v${latestTag.major}.${latestTag.minor}.${latestTag.patch + 1}`;
}

function runGit(rootDir: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function listGitTags(rootDir: string): ReadonlyArray<string> {
  const output = runGit(rootDir, ["tag", "--list"]);
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function getHeadCommit(rootDir: string): string {
  return runGit(rootDir, ["rev-parse", "--verify", "HEAD"]);
}

export function fetchGitTags(rootDir: string, remote: string): void {
  runGit(rootDir, ["fetch", remote, "--tags"]);
}

export function createAnnotatedReleaseTag(rootDir: string, tag: string): void {
  runGit(rootDir, ["tag", "-a", tag, "-m", `Release ${tag}`]);
}

export function pushReleaseTag(rootDir: string, remote: string, tag: string): void {
  runGit(rootDir, ["push", remote, `refs/tags/${tag}`]);
}

function parseArgs(argv: ReadonlyArray<string>): ReleaseTagOptions {
  let rootDir: string | undefined;
  let remote = "origin";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--root") {
      rootDir = argv[index + 1];
      if (!rootDir) {
        throw new Error("Missing value for --root.");
      }
      index += 1;
      continue;
    }

    if (argument === "--remote") {
      remote = argv[index + 1] ?? "";
      if (!remote) {
        throw new Error("Missing value for --remote.");
      }
      index += 1;
      continue;
    }

    throw new Error(
      "Usage: node scripts/release-next-version.ts [--root <path>] [--remote <name>]",
    );
  }

  return {
    rootDir,
    remote,
  };
}

export function resolveNextReleaseTag(options: ReleaseTagOptions): {
  readonly latestTag: StableReleaseTag | null;
  readonly nextTag: string;
  readonly headCommit: string;
} {
  const rootDir = options.rootDir ?? process.cwd();

  fetchGitTags(rootDir, options.remote);

  const latestTag = findLatestStableReleaseTag(listGitTags(rootDir));
  const nextTag = deriveNextReleaseTag(latestTag);
  const headCommit = getHeadCommit(rootDir);

  return {
    latestTag,
    nextTag,
    headCommit,
  };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = options.rootDir ?? process.cwd();
  const { latestTag, nextTag, headCommit } = resolveNextReleaseTag(options);

  console.log(`Latest stable release tag: ${latestTag?.tag ?? "none"}`);
  console.log(`Next stable release tag: ${nextTag}`);
  console.log(`Current HEAD commit: ${headCommit}`);
  createAnnotatedReleaseTag(rootDir, nextTag);
  console.log(`Created annotated tag ${nextTag}.`);
  pushReleaseTag(rootDir, options.remote, nextTag);
  console.log(`Pushed ${nextTag} to ${options.remote}.`);
}
