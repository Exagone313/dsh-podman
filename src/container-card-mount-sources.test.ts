// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createdName, namePattern } from "./client/container-card-names.js";
import type { MountInput } from "./client/card-protocol.js";
import {
  createdMountSource,
  firstMountDestinationError,
  mountRowBrowseDisabled,
  mountRowBrowseOffered,
  mountSourceAffordance,
  mountSourceCreationDisabled,
  mountSourceOptions,
  nonProjectDestinationError,
  revertCreatedMountSource,
  validateMountDestination,
  withPreselectedStorageSource,
} from "./client/container-card-mount-sources.js";

const projectsRoot = "/var/lib/dsh/projects";

// A client source file, read only in a source checkout: `pnpm test` runs from
// dist/, where the card's sources are not shipped.
function clientSource(name: string): string | undefined {
  const url = new URL(`../src/client/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

test("a mount row offers the affordance its kind takes", () => {
  // A project path is the one kind the host directory picker can choose; a
  // volume and a secret get their own create action instead, and tmpfs has no
  // source to fill.
  assert.equal(mountSourceAffordance("project"), "browse");
  assert.equal(mountSourceAffordance("volume"), "create-volume");
  assert.equal(mountSourceAffordance("secret"), "create-secret");
  assert.equal(mountSourceAffordance("tmpfs"), "none");
  // The decoded spellings reach the same decision as the short names.
  assert.equal(mountSourceAffordance("MOUNT_KIND_PROJECT"), "browse");
  assert.equal(mountSourceAffordance("MOUNT_KIND_VOLUME"), "create-volume");
  assert.equal(mountSourceAffordance("MOUNT_KIND_SECRET"), "create-secret");
  assert.equal(mountSourceAffordance("MOUNT_KIND_TMPFS"), "none");
  assert.equal(mountSourceAffordance(3), "create-volume");
  // An unspecified or unknown kind reads as a project mount, exactly like
  // normalizeMountKind, so its row is never left with no action.
  assert.equal(mountSourceAffordance(""), "browse");
  assert.equal(mountSourceAffordance(undefined), "browse");
});

test("creating a storage from a row matches the storage tab's gates", () => {
  // Both gates the settings storage tab uses: the snapshot must be writable and
  // no command may be in flight.
  assert.equal(mountSourceCreationDisabled(true, false), false);
  assert.equal(mountSourceCreationDisabled(false, false), true);
  assert.equal(mountSourceCreationDisabled(true, true), true);
  assert.equal(mountSourceCreationDisabled(false, true), true);
});

test("a listed project row offers Browse in its actions", () => {
  const browse = (): void => {};
  // An editor row for a project mount whose caller threaded a browser down.
  assert.equal(mountRowBrowseOffered("edit", "project", browse), true);
  assert.equal(
    mountRowBrowseOffered("edit", "MOUNT_KIND_PROJECT", browse),
    true,
  );
  // The block never gets it, nor does a row with no browser, nor another kind.
  assert.equal(mountRowBrowseOffered("view", "project", browse), false);
  assert.equal(mountRowBrowseOffered("edit", "project", undefined), false);
  for (const kind of ["volume", "secret", "tmpfs"] as const) {
    assert.equal(mountRowBrowseOffered("edit", kind, browse), false);
  }
  // A read-only workspace, a busy session and the row's own disabled state all
  // disable it, like the row's other write actions.
  assert.equal(mountRowBrowseDisabled(false, true, false), false);
  assert.equal(mountRowBrowseDisabled(true, true, false), true);
  assert.equal(mountRowBrowseDisabled(false, false, false), true);
  assert.equal(mountRowBrowseDisabled(false, true, true), true);
});

test("a created volume or secret is selected on its row", () => {
  assert.deepEqual(createdMountSource("volume", "data"), { volume: "data" });
  assert.deepEqual(createdMountSource("MOUNT_KIND_VOLUME", "data"), {
    volume: "data",
  });
  assert.deepEqual(createdMountSource("secret", "token"), { secret: "token" });
  assert.deepEqual(createdMountSource("MOUNT_KIND_SECRET", "token"), {
    secret: "token",
  });
  // A project or tmpfs row has no source a create could fill, and the empty
  // name is how a failed create puts the previous source back.
  assert.equal(createdMountSource("project", "team"), undefined);
  assert.equal(createdMountSource("tmpfs", "scratch"), undefined);
  assert.deepEqual(createdMountSource("volume", ""), { volume: "" });
});

test("a row keeps a just-created source selected until the snapshot lists it", () => {
  // The host creates asynchronously: on the first render after Create the
  // refreshed volumes list may not include the name yet, so the row carries it
  // itself and the picker shows it selected.
  const pending = mountSourceOptions("data", []);
  assert.equal(pending.missing, true);
  assert.deepEqual(pending.names, ["data"]);
  const pendingAmongOthers = mountSourceOptions("data", [
    { name: "cache" },
    { name: "logs" },
  ]);
  assert.equal(pendingAmongOthers.missing, true);
  assert.deepEqual(pendingAmongOthers.names, ["data", "cache", "logs"]);
  // Once the refreshed snapshot includes it, the name is listed once and is no
  // longer a row-local option.
  const refreshed = mountSourceOptions("data", [
    { name: "cache" },
    { name: "data" },
  ]);
  assert.equal(refreshed.missing, false);
  assert.deepEqual(refreshed.names, ["cache", "data"]);
  // An empty picker still offers the shared "None" value.
  const empty = mountSourceOptions("", []);
  assert.equal(empty.missing, false);
  assert.deepEqual(empty.names, []);
  // A stale selection the snapshot no longer lists stays selectable too.
  const stale = mountSourceOptions("removed", []);
  assert.equal(stale.missing, true);
  assert.deepEqual(stale.names, ["removed"]);
});

test("the create-volume dialog rejects empty and invalid names before creating", () => {
  // Nothing is created while the field breaks the rule, so the row is untouched.
  for (const invalid of ["", " ", "-data", "_data", "data volume", ".data"]) {
    assert.equal(createdName(invalid), undefined, `"${invalid}" is invalid`);
    assert.equal(namePattern.test(invalid), false);
  }
  assert.equal(createdName("x".repeat(65)), undefined);
  // A valid name is handed to the creator exactly as the host receives it.
  assert.equal(createdName("data"), "data");
  assert.equal(createdName("data.v1-2_3"), "data.v1-2_3");
  assert.equal(createdName("x".repeat(64)), "x".repeat(64));
});

test("a refused create restores the previous source and keeps a later pick", () => {
  // A duplicate name fails exactly as it does from the settings storage tab: the
  // host answers false, so the row puts back the source it carried before the
  // optimistic selection.
  assert.deepEqual(
    revertCreatedMountSource(
      { kind: "volume", volume: "data", secret: "" },
      "data",
      "",
    ),
    { volume: "" },
  );
  assert.deepEqual(
    revertCreatedMountSource(
      { kind: "secret", volume: "", secret: "token" },
      "token",
      "old-token",
    ),
    { secret: "old-token" },
  );
  // A source the user changed after the create started is not clobbered.
  assert.equal(
    revertCreatedMountSource(
      { kind: "volume", volume: "other", secret: "" },
      "data",
      "",
    ),
    undefined,
  );
  // A project or tmpfs row has no source to restore.
  assert.equal(
    revertCreatedMountSource(
      { kind: "project", volume: "", secret: "" },
      "data",
      "",
    ),
    undefined,
  );
  // A successful create leaves the adopted selection alone.
  assert.deepEqual(createdMountSource("volume", "data"), { volume: "data" });
});

test("the mount row renders one source action per kind", (t) => {
  const row = clientSource("container-card-shared.tsx");
  const actions = clientSource("container-card-mount-actions.tsx");
  if (row === undefined || actions === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // Our shared row no longer renders the source-field Browse button itself: it
  // hands the one affordance to the per-kind action component. A row-action
  // Browse is a separate, opt-in action the popup threads down.
  assert.match(row, /<MountSourceActions/);
  assert.match(row, /mountRowBrowseOffered/);
  assert.match(row, /mountRowBrowseDisabled/);
  assert.doesNotMatch(row, /labelAction|labelLine|mountProjectBrowseAction/);
  // Browse is the project affordance alone; volume and secret open their own
  // dialog, and both creation buttons carry the shared writable/busy gate.
  assert.match(actions, /affordance === "browse"/);
  assert.match(actions, /affordance === "create-volume"/);
  assert.match(actions, /affordance === "create-secret"/);
  // Each affordance carries its own wording: a project row says Browse, a
  // volume row Create volume and a secret row Create secret, while a tmpfs row
  // has no source and renders nothing.
  assert.match(actions, /\{t\("browse"\)\}/);
  assert.match(actions, /\{t\("createVolume"\)\}/);
  assert.match(actions, /\{t\("createSecret"\)\}/);
  assert.match(actions, /<CreateVolumeModal/);
  assert.match(actions, /<SecretModal/);
  assert.equal(
    actions.match(/mountSourceCreationDisabled\(writable, busy\)/g)?.length,
    2,
  );
});

test("only the Add-mount row offers a storage creation action", (t) => {
  const editors = clientSource("container-card-editors.tsx");
  if (editors === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The editor renders the existing mounts as list rows and the mount being
  // added as a draft row inside the Add-mount popup; both are a MountRow.
  const rows = [...editors.matchAll(/<MountRow[\s\S]*?\/>/g)].map(
    (match) => match[0],
  );
  assert.equal(rows.length, 2);
  const listRow = rows[0];
  const addRow = rows[1];
  // An existing mount keeps only its source picker and Remove: creation belongs
  // to the Add-mount popup, not to every row already in the list.
  assert.doesNotMatch(listRow, /onCreateVolume/);
  assert.doesNotMatch(listRow, /onCreateSecret/);
  assert.match(listRow, /onRemove=/);
  // The draft row keeps both creation callbacks and its Browse affordance, one
  // of which renders per the kind being added.
  assert.match(addRow, /onCreateVolume=\{onCreateVolume\}/);
  assert.match(addRow, /onCreateSecret=\{onCreateSecret\}/);
  assert.match(addRow, /onBrowse=/);
});

test("the settings tab and the container editors still open the shared dialogs", (t) => {
  const volumes = clientSource("container-card-volumes.tsx");
  const secrets = clientSource("container-card-secrets.tsx");
  const actions = clientSource("container-card-mount-actions.tsx");
  const templates = clientSource("container-card-templates.tsx");
  if (
    volumes === undefined || secrets === undefined ||
    actions === undefined || templates === undefined
  ) {
    t.skip("not a source checkout");
    return;
  }
  // The storage tab's volume card renders the extracted dialog instead of its
  // own inline form.
  assert.match(volumes, /<CreateVolumeModal/);
  assert.doesNotMatch(volumes, /<Modal/);
  assert.doesNotMatch(volumes, /namePattern/);
  // Creating a secret or a volume from the template popup opens the same
  // dialogs the settings tab and the mount rows use, so there is one form.
  assert.match(templates, /<CreateVolumeModal/);
  assert.match(templates, /<SecretModal/);
  assert.match(secrets, /<SecretModal/);
  assert.match(actions, /<CreateVolumeModal/);
  assert.match(actions, /<SecretModal/);
});

test("the storage creators are threaded to the mount rows", (t) => {
  const names = [
    "ContainerCard.tsx",
    "container-card-workspace.tsx",
    "container-card-row.tsx",
    "container-card-edit-modal.tsx",
    "container-card-create-modal.tsx",
    "container-card-form.tsx",
    "container-card-editors.tsx",
    "podman-containers.tsx",
  ];
  const sources = names.map((name) => [name, clientSource(name)] as const);
  if (sources.some(([, source]) => source === undefined)) {
    t.skip("not a source checkout");
    return;
  }
  const source = (name: string): string =>
    sources.find(([file]) => file === name)?.[1] ?? "";
  // Both surfaces the card has — the settings page and the sidebar panel — pass
  // the same volume creator down; the edit dialog, which had none before, now
  // carries it too.
  assert.match(
    source("ContainerCard.tsx"),
    /onCreateVolume=\{props\.createVolume\}/,
  );
  assert.match(
    source("podman-containers.tsx"),
    /onCreateVolume=\{props\.createVolume\}/,
  );
  assert.match(
    source("container-card-workspace.tsx"),
    /createVolume=\{onCreateVolume\}/,
  );
  assert.match(
    source("container-card-row.tsx"),
    /createVolume=\{createVolume\}/,
  );
  assert.match(
    source("container-card-edit-modal.tsx"),
    /onCreateVolume=\{createVolume\}/,
  );
  assert.match(
    source("container-card-create-modal.tsx"),
    /onCreateVolume=\{createVolume\}/,
  );
  // The form hands both creators and the write permission to the mounts editor,
  // which hands them to the Add-mount popup's draft row only.
  assert.match(
    source("container-card-form.tsx"),
    /<MountsEditor[\s\S]*onCreateVolume=\{onCreateVolume\}/,
  );
  assert.equal(
    source("container-card-editors.tsx")
      .match(/onCreateVolume=\{onCreateVolume\}/g)?.length,
    1,
  );
  assert.equal(
    source("container-card-editors.tsx")
      .match(/onCreateSecret=\{onCreateSecret\}/g)?.length,
    1,
  );
});

// An Add-mount draft as the popup starts it: no source stored yet.
const emptyDraft = (kind: string): MountInput => ({
  kind,
  project: "",
  destination: "",
  mode: kind === "tmpfs" ? "read_write" : "read_only",
  volume: "",
  secret: "",
});

test("an empty draft preselects the first storage of its kind", () => {
  const volumes = [{ name: "cache" }, { name: "data" }];
  const secrets = [{ name: "token" }, { name: "api-key" }];
  // With several entries the first is stored, which is exactly what a picker
  // with no "" option displays, so the draft no longer lags behind the field.
  assert.deepEqual(
    withPreselectedStorageSource(emptyDraft("volume"), volumes, secrets),
    { ...emptyDraft("volume"), volume: "cache" },
  );
  assert.deepEqual(
    withPreselectedStorageSource(emptyDraft("secret"), volumes, secrets),
    { ...emptyDraft("secret"), secret: "token" },
  );
  // The decoded spelling reaches the same branch.
  assert.deepEqual(
    withPreselectedStorageSource(
      emptyDraft("MOUNT_KIND_VOLUME"),
      volumes,
      secrets,
    ),
    { ...emptyDraft("MOUNT_KIND_VOLUME"), volume: "cache" },
  );
  // Every other kind carries no source, so the draft is returned as it is.
  const project = emptyDraft("project");
  const tmpfs = emptyDraft("tmpfs");
  assert.equal(
    withPreselectedStorageSource(project, volumes, secrets),
    project,
  );
  assert.equal(withPreselectedStorageSource(tmpfs, volumes, secrets), tmpfs);
  // An empty list leaves the field empty: Add stays disabled and the creation
  // actions remain the way to fill it.
  assert.equal(
    withPreselectedStorageSource(emptyDraft("secret"), volumes, []).secret,
    "",
  );
  // A value already chosen — including one the snapshot no longer lists — is
  // never overwritten, and no draft is mutated in place.
  const stale = { ...emptyDraft("volume"), volume: "removed" };
  const chosen = { ...emptyDraft("secret"), secret: "kept" };
  assert.equal(withPreselectedStorageSource(stale, volumes, secrets), stale);
  assert.equal(withPreselectedStorageSource(chosen, volumes, secrets), chosen);
  assert.deepEqual(stale, { ...emptyDraft("volume"), volume: "removed" });
  assert.deepEqual(chosen, { ...emptyDraft("secret"), secret: "kept" });
});

test("the Add-mount popup preselects on open, on kind change and on list change", (t) => {
  const editors = clientSource("container-card-editors.tsx");
  if (editors === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The popup applies the shared helper instead of changing the control's
  // rendering.
  assert.match(
    editors,
    /import \{[^}]*withPreselectedStorageSource[^}]*\} from "\.\/container-card-mount-sources\.js";/,
  );
  // On open, the pristine draft is preselected; it is a project draft, so it
  // carries no storage source.
  assert.match(
    editors,
    /setDraft\(withPreselectedStorageSource\(emptyMount\(\), volumes, secrets\)\)/,
  );
  // On a kind change, the pristine draft for the new kind adopts that kind's
  // first entry, so project → secret → volume picks the first of each list and
  // tmpfs leaves no source.
  assert.match(
    editors,
    /const next = emptyMount\(event\.target\.value\);\s*setDraft\(\s*withPreselectedStorageSource\(next, volumes, secrets\)/,
  );
  // While the popup is open, a list that fills or changes — a storage created
  // from it — feeds the draft again, but only into an empty source.
  assert.match(
    editors,
    /useEffect\(\(\) => \{\s*if \(!adding\) return;\s*setDraft\(\(previous\) =>\s*withPreselectedStorageSource\(previous, volumes, secrets\),?\s*\);\s*\}, \[adding, volumes, secrets\]\);/,
  );
  // Add's gate still reads the draft's own value, so the stored preselection
  // enables it as soon as the field shows a name; the busy/checking gates stay.
  assert.match(editors, /draft\.volume !== ""/);
  assert.match(editors, /draft\.secret !== ""/);
  assert.match(editors, /disabled=\{busy \|\| !canAdd \|\| checking\}/);
});

test("the shared source control and the template popup keep their rendering", (t) => {
  const row = clientSource("container-card-shared.tsx");
  const templates = clientSource("container-card-templates.tsx");
  if (row === undefined || templates === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The shared control still shows whatever value it is handed: it gains no
  // preselection of its own, keeps both pickers and the single "" option an
  // empty list renders.
  assert.doesNotMatch(row, /withPreselectedStorageSource/);
  assert.match(row, /options\.names\.length === 0/);
  assert.match(row, /mountSourceOptions\(props\.volume, props\.volumes\)/);
  assert.match(row, /mountSourceOptions\(props\.secret, props\.secrets\)/);
  // The template popup still delegates its mount rows to the shared editor and
  // preselects nothing itself.
  assert.match(templates, /<MountsEditor/);
  assert.doesNotMatch(templates, /withPreselectedStorageSource/);
});

test("a non-project destination must be a clean absolute path", () => {
  // Accepted: a plain absolute path, a name that merely starts with "tmp", and
  // a sibling of the projects root.
  for (
    const destination of ["/data", "/tmp2", "/opt/app", "/var/lib/dsh/other"]
  ) {
    assert.deepEqual(
      validateMountDestination(destination, projectsRoot),
      { ok: true },
      destination,
    );
  }
  // Empty is its own message; the relative shapes — "." and ".." included —
  // never reach the cleanliness rules because they are not absolute.
  assert.deepEqual(validateMountDestination("", projectsRoot), {
    ok: false,
    key: "mountDestinationRequired",
  });
  for (const destination of ["data", "./data", "../data", ".", ".."]) {
    assert.deepEqual(
      validateMountDestination(destination, projectsRoot),
      { ok: false, key: "mountDestinationAbsolute" },
      destination,
    );
  }
  // No ".." segment, no "." segment, no doubled separator and no trailing
  // slash: the same equality filepath.Clean enforces on the host.
  for (const destination of ["/data/../x", "/data/./x", "/data//x", "//data"]) {
    assert.deepEqual(
      validateMountDestination(destination, projectsRoot),
      { ok: false, key: "mountDestinationClean" },
      destination,
    );
  }
  for (const destination of ["/data/", "/data/x/"]) {
    assert.deepEqual(
      validateMountDestination(destination, projectsRoot),
      { ok: false, key: "mountDestinationClean" },
      destination,
    );
  }
});

test("a destination must not be or overlap /tmp or the projects root", () => {
  const tmp = {
    ok: false,
    key: "mountDestinationReserved",
    params: { path: "/tmp" },
  } as const;
  for (const destination of ["/tmp", "/tmp/x", "/tmp/a/b"]) {
    assert.deepEqual(
      validateMountDestination(destination, projectsRoot),
      tmp,
      destination,
    );
  }
  // "/" is the one clean absolute ancestor of /tmp; /tmp2 is only a name that
  // starts the same way, so it is allowed.
  assert.deepEqual(validateMountDestination("/", projectsRoot), tmp);
  assert.deepEqual(validateMountDestination("/tmp2", projectsRoot), {
    ok: true,
  });
  const root = {
    ok: false,
    key: "mountDestinationReserved",
    params: { path: projectsRoot },
  } as const;
  for (
    const destination of [
      projectsRoot,
      `${projectsRoot}/team`,
      `${projectsRoot}/team/src`,
      "/var/lib",
      "/var",
    ]
  ) {
    assert.deepEqual(
      validateMountDestination(destination, projectsRoot),
      root,
      destination,
    );
  }
  // A sibling of the projects root is neither inside it nor above it.
  for (
    const destination of ["/var/lib/dsh/other", "/var/lib/dsh/projects2"]
  ) {
    assert.deepEqual(validateMountDestination(destination, projectsRoot), {
      ok: true,
    });
  }
});

test("an empty or unconfigured projects root reserves nothing of its own", () => {
  for (const destination of ["/data", "/projects", projectsRoot]) {
    assert.deepEqual(validateMountDestination(destination, ""), { ok: true });
  }
  // /tmp is known without the snapshot, so it stays reserved.
  assert.deepEqual(validateMountDestination("/tmp", ""), {
    ok: false,
    key: "mountDestinationReserved",
    params: { path: "/tmp" },
  });
  // A relative root cannot name a container path, so it reserves nothing.
  assert.deepEqual(validateMountDestination("/projects", "projects"), {
    ok: true,
  });
});

test("only volume, secret and tmpfs rows validate their destination", () => {
  for (
    const kind of [
      "volume",
      "secret",
      "tmpfs",
      "MOUNT_KIND_VOLUME",
      "MOUNT_KIND_SECRET",
      "MOUNT_KIND_TMPFS",
    ]
  ) {
    assert.deepEqual(nonProjectDestinationError(kind, "", projectsRoot), {
      key: "mountDestinationRequired",
    });
    assert.equal(
      nonProjectDestinationError(kind, "/data", projectsRoot),
      undefined,
    );
  }
  // A project mount derives its destination, and an unknown kind reads as one,
  // exactly like normalizeMountKind.
  for (const kind of ["project", "MOUNT_KIND_PROJECT", undefined, "unknown"]) {
    assert.equal(
      nonProjectDestinationError(kind, "", projectsRoot),
      undefined,
    );
  }
});

test("the first refused destination is reported in list order", () => {
  const project = { kind: "project", destination: "" };
  const volume = { kind: "volume", destination: "/data" };
  const tmpfs = { kind: "tmpfs", destination: "/tmp/x" };
  const secret = { kind: "secret", destination: "" };
  // The tmpfs row is the first one that fails, so it names the reason.
  assert.deepEqual(
    firstMountDestinationError([project, volume, tmpfs, secret], projectsRoot),
    { key: "mountDestinationReserved", params: { path: "/tmp" } },
  );
  // Fixing that row surfaces the next bad one, and fixing every row clears it.
  assert.deepEqual(
    firstMountDestinationError(
      [project, volume, { kind: "tmpfs", destination: "/scratch" }, secret],
      projectsRoot,
    ),
    { key: "mountDestinationRequired" },
  );
  assert.equal(
    firstMountDestinationError(
      [
        project,
        volume,
        { kind: "tmpfs", destination: "/scratch" },
        { kind: "secret", destination: "/run/secret" },
      ],
      projectsRoot,
    ),
    undefined,
  );
  assert.equal(firstMountDestinationError([], projectsRoot), undefined);
});
