---
name: release-notes
description: Draft the release notes for an upcoming dsh-podman release — user-facing changes and dependency or version updates included — review them with the maintainer, and pass the approved summary to the version bump script.
whenToUse: Use when preparing a release, to summarize the user-facing changes since the previous tag, get the summary approved, and create the version bump commit and tag with those notes.
---

# Release notes

Write the release notes from the commits since the previous tag, keep the
changes a user can observe or depend on, and get the draft approved before
tagging.

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
   not assemble a notes body and do not run the bump script. The maintainer then
   decides whether to skip the release entirely or cut it as maintenance-only;
   only if they confirm the release goes ahead, replace the summary with a
   single maintenance line they approve.
6. Write a short Markdown list: a handful of lines, one sentence each. Never
   create a file for the notes; keep the text in the conversation.

## Get the notes approved

Show the draft with the question tool, and ask whether to use it as is, edit
specific lines, or regenerate the list from the commit range. Apply the chosen
change and ask again only if the result is materially different.

Where the question tool is unavailable, present the draft and stop: do not bump
the version until the notes are approved.

## Bump the version with the notes

Only after approval, pass the approved text to the bump script:

```sh
pnpm bump-version <version> --notes "<approved notes>"
```

For a multi-line body, `--notes -` reads the notes from stdin. The command
writes the version to `package.json`, commits `chore: bump version to <version>`
with the notes as its body, and creates an annotated tag whose message is the
notes; it pushes nothing. The release workflow publishes that tag message as the
GitHub release description. Omitting `--notes` keeps the single-line commit and
a lightweight tag, and the release falls back to auto-generated notes.
