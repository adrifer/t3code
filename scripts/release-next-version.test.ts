import { assert, describe, it } from "@effect/vitest";

import {
  deriveNextReleaseTag,
  findLatestStableReleaseTag,
  parseStableReleaseTag,
} from "./release-next-version.ts";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return runCommand(cwd, "git", args);
}

function runCommand(cwd: string, command: string, args: ReadonlyArray<string>): string {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    throw new Error(result.stderr.toString().trim() || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout.toString().trim();
}

async function createCommit(repoDir: string, name: string, contents: string): Promise<void> {
  const filePath = `${repoDir}/${name}`;
  await Bun.write(filePath, contents);
  runGit(repoDir, ["add", name]);
  runGit(repoDir, ["commit", "-m", `Add ${name}`]);
}

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

  it("creates and pushes the next stable tag from HEAD", async () => {
    const tempRoot = runCommand(process.cwd(), "mktemp", ["-d", "-t", "t3-release-tag-XXXXXX"]);
    const repoDir = `${tempRoot}/repo`;
    const remoteDir = `${tempRoot}/remote.git`;
    runCommand(tempRoot, "mkdir", [repoDir]);

    try {
      runGit(tempRoot, ["init", "--bare", remoteDir]);
      runGit(repoDir, ["init"]);
      runGit(repoDir, ["config", "user.name", "T3 Test"]);
      runGit(repoDir, ["config", "user.email", "t3@example.com"]);

      await createCommit(repoDir, "README.md", "# temp repo\n");
      runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      runGit(repoDir, ["tag", "-a", "v0.0.5", "-m", "Release v0.0.5"]);
      runGit(repoDir, ["tag", "-a", "v0.0.5-test.1", "-m", "Release v0.0.5-test.1"]);

      const output = runCommand(repoDir, process.execPath, [
        `${repoRoot}/scripts/release-next-version.ts`,
      ]);

      assert.match(output, /Latest stable release tag: v0\.0\.5/);
      assert.match(output, /Next stable release tag: v0\.0\.6/);
      assert.match(output, /Created annotated tag v0\.0\.6\./);
      assert.match(output, /Pushed v0\.0\.6 to origin\./);
      assert.equal(runGit(repoDir, ["tag", "--list", "v0.0.6"]), "v0.0.6");
      assert.equal(runGit(remoteDir, ["tag", "--list", "v0.0.6"]), "v0.0.6");
    } finally {
      runCommand(process.cwd(), "rm", ["-rf", tempRoot]);
    }
  });
});
