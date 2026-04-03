---
name: release-version
description: Create the next stable patch release tag for this repository by finding the latest vX.Y.Z tag, incrementing it, tagging the current HEAD commit, and pushing the new tag.
---

# Release Version

Use this skill when asked to cut the next release tag for this repository.

## What this skill does

1. Uses the repository release conventions from `docs/release.md` and `.github/workflows/release.yml`.
2. Looks at existing stable release tags that match `vX.Y.Z`.
3. Ignores prerelease tags such as `v0.0.0-test.1` when choosing the base version.
4. Computes the next patch tag from the latest stable tag.
5. Tags the current `HEAD` commit and pushes the new tag to the remote.

## Commands

Preview the next stable tag:

```bash
bun run release:tag -- --fetch-tags
```

Create and push the new tag to `origin`:

```bash
bun run release:tag -- --fetch-tags --create --push
```

Use a different remote if needed:

```bash
bun run release:tag -- --fetch-tags --create --push --remote upstream
```

## Notes

- The helper script is `scripts/release-next-version.ts`.
- The script creates an **annotated** tag on the current `HEAD` commit.
- The script pushes only the newly created tag, not every local tag.
- Pushing a `v*.*.*` tag triggers `.github/workflows/release.yml`.
