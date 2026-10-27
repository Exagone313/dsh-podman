---
name: release-notes
description: Draft the release notes for an upcoming dsh-podman release — user-facing changes and dependency or version updates included — choose the version from the commits since the previous tag or use the one supplied, review both with the maintainer, and pass the approved summary and version to the version bump script.
whenToUse: Use when preparing a release, to summarize the user-facing changes since the previous tag, choose or accept the release version (semver-derived or given), get the summary approved, and create the version bump commit and tag with those notes.
---

# Release notes

Write the release notes from the commits since the previous tag, keep the
changes a user can observe or depend on, and get the notes and the target
version approved before tagging.

## Draft the notes

1. Find the previous release tag:

   ```sh
   git describe --tags --abbrev=0
   ```

2. Read the commits since that tag:

   ```sh
   git log --oneline <previous-tag>..HEAD
   ```

3. Keep user-facing changes: new features, behaviour changes, fixes a user can
   see, and dependency or version changes. A harness/dsh upgrade, a pinned
   dependency bump, an override added for a security advisory, or a
   security-driven update matters to users; never drop one as noise. Give each
   notable change its own line, or summarise several smaller bumps in a single
   "Dependencies" line.
4. Drop pure noise: internal refactors, test-only changes, and CI tweaks that do
   not affect what ships.
5. If nothing left in the range is user-facing and nothing is a dependency or
   version change, report that there are no user-visible changes and stop: do
   not assemble a notes body, do not choose a version, and do not run the bump
   script. The maintainer then decides whether to skip the release entirely or
   cut it as maintenance-only; only if they confirm the release goes ahead,
   replace the summary with a single maintenance line they approve.
6. Write a short Markdown list: a handful of lines, one sentence each. Never
   create a file for the notes; keep the text in the conversation.

## Choose the version

The version may be given with the request, or derived here. Pick it before
asking for approval, so the notes and the version are approved together.

1. If the request names a version — "draft the release notes for `1.8.0`",
   "release `2.0.0-rc.1`", or a version passed as the skill's argument — use it.
   Validate that it is a bare semver (`x.y.z`, no `v`, optionally with a
   `-prerelease` suffix) and greater than `package.json`'s version, except
   between pre-releases. If it is malformed, equal or lower, say why and ask for
   another version; never correct it silently.

2. Otherwise derive it from the commits since the previous tag. Read the
   subjects and bodies, and take the highest change in the range:

   ```sh
   git log --format='%s%n%b' <previous-tag>..HEAD
   ```

   - **major** when any subject carries `!` after the type or scope (`feat!:`,
     `fix(scope)!:`) or any body has a `BREAKING CHANGE:` or `BREAKING-CHANGE:`
     footer;
   - **minor** when any commit is otherwise a `feat(` or `feat:`;
   - **patch** for everything else, including fixes, performance and dependency
     or tooling bumps.

   Apply the level to the previous tag's version: `1.7.0` becomes `2.0.0` for
   major, `1.8.0` for minor, `1.7.1` for patch. The version is always bare, with
   no `v` prefix, because the release workflow requires it.
   - If the previous tag is a pre-release (`1.8.0-rc.1`), derive the final
     release of the same core (`1.8.0`) unless a breaking change since that tag
     raises the major; a further pre-release comes only from an explicit
     version.
   - If no tag exists, use `package.json`'s version as the base.
   - If `package.json`'s version is greater than the previous tag, a bump may
     already be prepared: say so and confirm whether to reuse that version or
     bump again, instead of deriving over it.

3. Keep a one-line reason for the approval, for example: "25 commits since
   1.7.0; the highest change is a `feat`, so 1.8.0."

## Get the notes and version approved

Show the draft and the target version with its reason, then ask whether to use
them as is, edit specific lines, regenerate the list from the commit range, or
override the version — to the next patch, minor or major release, or to another
version the maintainer gives. Apply the chosen change and ask again only if the
result is materially different.

Where the question tool is unavailable, present the draft and version and stop:
do not bump until both are approved.

## Bump the version with the notes

Only after approval, pass the approved version and text to the bump script:

```sh
pnpm bump-version <approved-version> --notes "<approved notes>"
```

When the version needs a check before touching the tree, run the same command
with `--dry-run` first: it validates the version against `package.json` and the
notes without changing anything.

For a multi-line body, `--notes -` reads the notes from stdin. The command
writes the version to `package.json`, commits `chore: bump version to
<approved-version>` with the notes as its body, and creates an annotated tag
whose message is the notes; it pushes nothing. The release workflow publishes
that tag message as the GitHub release description. Omitting `--notes` keeps the
single-line commit and a lightweight tag, and the release falls back to
auto-generated notes.
