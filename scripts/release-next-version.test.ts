import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

import {
  deriveNextReleaseTag,
  findLatestStableReleaseTag,
  parseStableReleaseTag,
} from "./release-next-version.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createCommit(repoDir: string, name: string, contents: string): void {
  const filePath = resolve(repoDir, name);
  writeFileSync(filePath, contents);
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

  it("creates and pushes the next stable tag from HEAD", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "t3-release-tag-"));
    const repoDir = resolve(tempRoot, "repo");
    const remoteDir = resolve(tempRoot, "remote.git");
    mkdirSync(repoDir);

    try {
      runGit(tempRoot, ["init", "--bare", remoteDir]);
      runGit(repoDir, ["init"]);
      runGit(repoDir, ["config", "user.name", "T3 Test"]);
      runGit(repoDir, ["config", "user.email", "t3@example.com"]);

      createCommit(repoDir, "README.md", "# temp repo\n");
      runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      runGit(repoDir, ["tag", "-a", "v0.0.5", "-m", "Release v0.0.5"]);
      runGit(repoDir, ["tag", "-a", "v0.0.5-test.1", "-m", "Release v0.0.5-test.1"]);

      const output = execFileSync(
        process.execPath,
        [resolve(repoRoot, "scripts/release-next-version.ts")],
        {
          cwd: repoDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      assert.match(output, /Latest stable release tag: v0\.0\.5/);
      assert.match(output, /Next stable release tag: v0\.0\.6/);
      assert.match(output, /Created annotated tag v0\.0\.6\./);
      assert.match(output, /Pushed v0\.0\.6 to origin\./);
      assert.equal(runGit(repoDir, ["tag", "--list", "v0.0.6"]), "v0.0.6");
      assert.equal(runGit(remoteDir, ["tag", "--list", "v0.0.6"]), "v0.0.6");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
