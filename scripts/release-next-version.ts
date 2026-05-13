import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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

class ReleaseTagError extends Data.TaggedError("ReleaseTagError")<{
  readonly message: string;
}> {}

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

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runGit = Effect.fn("runGit")(function* (rootDir: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("git", ["-C", rootDir, ...args]));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new ReleaseTagError({
      message: stderr.trim() || `git ${args.join(" ")} failed`,
    });
  }
  return stdout.trim();
});

export const listGitTags = Effect.fn("listGitTags")(function* (rootDir: string) {
  const output = yield* runGit(rootDir, ["tag", "--list"]);
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
});

export const getHeadCommit = Effect.fn("getHeadCommit")((rootDir: string) =>
  runGit(rootDir, ["rev-parse", "--verify", "HEAD"]),
);

export const fetchGitTags = Effect.fn("fetchGitTags")(function* (rootDir: string, remote: string) {
  yield* runGit(rootDir, ["fetch", remote, "--tags"]);
});

export const createAnnotatedReleaseTag = Effect.fn("createAnnotatedReleaseTag")(function* (
  rootDir: string,
  tag: string,
) {
  yield* runGit(rootDir, ["tag", "-a", tag, "-m", `Release ${tag}`]);
});

export const pushReleaseTag = Effect.fn("pushReleaseTag")(function* (
  rootDir: string,
  remote: string,
  tag: string,
) {
  yield* runGit(rootDir, ["push", remote, `refs/tags/${tag}`]);
});

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

export const resolveNextReleaseTag = Effect.fn("resolveNextReleaseTag")(function* (
  options: ReleaseTagOptions,
) {
  const rootDir = options.rootDir ?? process.cwd();

  yield* fetchGitTags(rootDir, options.remote);

  const latestTag = findLatestStableReleaseTag(yield* listGitTags(rootDir));
  const nextTag = deriveNextReleaseTag(latestTag);
  const headCommit = yield* getHeadCommit(rootDir);

  return {
    latestTag,
    nextTag,
    headCommit,
  };
});

const isMain =
  process.argv[1] !== undefined && process.argv[1] === new URL(import.meta.url).pathname;

if (isMain) {
  Effect.gen(function* () {
    const options = parseArgs(process.argv.slice(2));
    const rootDir = options.rootDir ?? process.cwd();
    const { latestTag, nextTag, headCommit } = yield* resolveNextReleaseTag(options);

    process.stdout.write(`Latest stable release tag: ${latestTag?.tag ?? "none"}\n`);
    process.stdout.write(`Next stable release tag: ${nextTag}\n`);
    process.stdout.write(`Current HEAD commit: ${headCommit}\n`);
    yield* createAnnotatedReleaseTag(rootDir, nextTag);
    process.stdout.write(`Created annotated tag ${nextTag}.\n`);
    yield* pushReleaseTag(rootDir, options.remote, nextTag);
    process.stdout.write(`Pushed ${nextTag} to ${options.remote}.\n`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
