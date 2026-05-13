import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  deriveNextReleaseTag,
  findLatestStableReleaseTag,
  parseStableReleaseTag,
} from "./release-next-version.ts";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

class TestCommandError extends Data.TaggedError("TestCommandError")<{
  readonly message: string;
}> {}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runCommand = Effect.fn("runCommand")(function* (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(command, args, { cwd }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new TestCommandError({
      message: stderr.trim() || `${command} ${args.join(" ")} failed`,
    });
  }
  return stdout.trim();
});

const runGit = (cwd: string, args: ReadonlyArray<string>) => runCommand(cwd, "git", args);

const createCommit = Effect.fn("createCommit")(function* (
  repoDir: string,
  name: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(repoDir, name), contents);
  yield* runGit(repoDir, ["add", name]);
  yield* runGit(repoDir, ["commit", "-m", `Add ${name}`]);
});

describe("release-next-version", () => {
  it("finds the latest stable tag and ignores prereleases", () => {
    const latestTag = findLatestStableReleaseTag([
      "v0.0.5",
      "v0.0.7-test.1",
      "v0.0.9",
      "v0.1.0-beta.1",
      "not-a-tag",
      "v0.0.10",
    ]);

    assert.deepStrictEqual(parseStableReleaseTag("v0.0.10"), latestTag);
    assert.equal(deriveNextReleaseTag(latestTag), "v0.0.11");
  });

  it("starts at v0.0.1 when no stable release tags exist", () => {
    const latestTag = findLatestStableReleaseTag(["v0.0.1-beta.1", "preview"]);

    assert.equal(latestTag, null);
    assert.equal(deriveNextReleaseTag(latestTag), "v0.0.1");
  });

  it.layer(NodeServices.layer)("integration", (it) => {
    it.effect(
      "creates and pushes the next stable tag from HEAD",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-release-tag-",
          });
          const repoDir = path.join(tempRoot, "repo");
          const remoteDir = path.join(tempRoot, "remote.git");
          yield* fileSystem.makeDirectory(repoDir);

          yield* runGit(tempRoot, ["init", "--bare", remoteDir]);
          yield* runGit(repoDir, ["init"]);
          yield* runGit(repoDir, ["config", "user.name", "T3 Test"]);
          yield* runGit(repoDir, ["config", "user.email", "t3@example.com"]);

          yield* createCommit(repoDir, "README.md", "# temp repo\n");
          yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
          yield* runGit(repoDir, ["tag", "-a", "v0.0.5", "-m", "Release v0.0.5"]);
          yield* runGit(repoDir, ["tag", "-a", "v0.0.5-test.1", "-m", "Release v0.0.5-test.1"]);

          const output = yield* runCommand(repoDir, process.execPath, [
            `${repoRoot}/scripts/release-next-version.ts`,
          ]);

          assert.match(output, /Latest stable release tag: v0\.0\.5/);
          assert.match(output, /Next stable release tag: v0\.0\.6/);
          assert.match(output, /Created annotated tag v0\.0\.6\./);
          assert.match(output, /Pushed v0\.0\.6 to origin\./);
          assert.equal(yield* runGit(repoDir, ["tag", "--list", "v0.0.6"]), "v0.0.6");
          assert.equal(
            yield* runCommand(tempRoot, "git", ["--git-dir", remoteDir, "tag", "--list", "v0.0.6"]),
            "v0.0.6",
          );
        }),
      15_000,
    );
  });
});
