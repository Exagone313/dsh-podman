// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_IMAGE_PACKAGES,
  canonicalPackages,
  exportContainerTemplate,
  parseContainerTemplate,
  renderContainerTemplate,
  sanitizedTemplateName,
  sha256Hex,
  templateExportImage,
  templateImageId,
  templateImageIdFromDigest,
  templateImagePlan,
  templateRequirements,
  validateTemplate,
} from "./container-template.js";

const MINIMAL = `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
`;

function failure(text: string): string {
  try {
    parseContainerTemplate(text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the template to be refused");
}

test("a minimal template parses and gets empty optional groups", () => {
  const template = parseContainerTemplate(MINIMAL);
  assert.deepEqual(template.spec, {
    image: "ubuntu",
    env: {},
    secretEnv: {},
    mounts: [],
    paths: [],
    ports: [],
  });
});

test("unknown version, kind and keys are refused rather than ignored", () => {
  assert.match(
    failure(MINIMAL.replace("version: 1", "version: 2")),
    /version: unsupported version/,
  );
  assert.match(
    failure(MINIMAL.replace("dsh-podman/container-template", "other")),
    /kind: unsupported kind/,
  );
  assert.match(
    failure(`${MINIMAL}  command: [bash]\n`),
    /spec\.command: unknown key/,
  );
  assert.match(
    failure("version: 1\nkind: dsh-podman/container-template\n"),
    /spec/,
  );
});

test("exactly one of image and imageTemplate is required", () => {
  const both = `${MINIMAL}  imageTemplate: {base: ubuntu, packages: [jq]}\n`;
  assert.match(failure(both), /exactly one of image and imageTemplate/);
  assert.match(
    failure("version: 1\nkind: dsh-podman/container-template\nspec: {}\n"),
    /exactly one of image and imageTemplate/,
  );
});

test("only the three declared base images are accepted", () => {
  assert.match(
    failure(MINIMAL.replace("ubuntu", "debian")),
    /unsupported base image "debian"/,
  );
  assert.match(
    failure(
      "version: 1\nkind: dsh-podman/container-template\nspec:\n  imageTemplate: {base: fedora, packages: [git]}\n",
    ),
    /imageTemplate\.base: unsupported base image "fedora"/,
  );
});

test("packages already in the base are ignored and a base-only list refers to the base", () => {
  const builtins = BASE_IMAGE_PACKAGES.ubuntu;
  const template = parseContainerTemplate(
    `version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate:
    base: ubuntu
    packages: [${builtins.slice(0, 3).join(", ")}]
`,
  );
  assert.equal(template.spec.image, "ubuntu");
  assert.equal(template.spec.imageTemplate, undefined);
});

test("template packages are canonical: deduplicated, built-ins dropped, sorted", () => {
  const template = parseContainerTemplate(
    `version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate:
    base: alpine
    packages: [ripgrep, zzz, git, aaa, zzz, bash]
`,
  );
  assert.deepEqual(template.spec.imageTemplate, {
    base: "alpine",
    packages: ["aaa", "zzz"],
  });
  assert.deepEqual(
    canonicalPackages("alpine", [
      "zzz",
      "aaa",
      "zzz",
      "git",
    ]),
    ["aaa", "zzz"],
  );
});

test("mount keys are matched to their kind", () => {
  const template = (mount: string): string =>
    `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  mounts:
    - ${mount}
`;
  assert.deepEqual(
    parseContainerTemplate(template("{kind: project, project: app}")).spec
      .mounts,
    [{ kind: "project", project: "app", mode: "read_only" }],
  );
  // A project mount never takes a destination, but it does take a mode.
  assert.match(
    failure(template("{kind: project, project: app, destination: /x}")),
    /project mount does not take "destination"/,
  );
  assert.deepEqual(
    parseContainerTemplate(
      template("{kind: project, project: app, mode: read_write}"),
    ).spec.mounts,
    [{ kind: "project", project: "app", mode: "read_write" }],
  );
  // A secret mount is read-only and names a secret, never a value.
  assert.match(
    failure(
      template(
        "{kind: secret, secret: npm-token, destination: /root/.npmrc, mode: read_write}",
      ),
    ),
    /secret mount does not take "mode"/,
  );
  assert.match(
    failure(
      template("{kind: secret, value: hunter2, destination: /root/.npmrc}"),
    ),
    /unknown key "value"/,
  );
  // A tmpfs carries a destination only, and no mode either.
  assert.match(
    failure(template("{kind: tmpfs, destination: /scratch, size: 1G}")),
    /tmpfs mount does not take "size"/,
  );
  assert.match(
    failure(
      template("{kind: tmpfs, destination: /scratch, mode: read_write}"),
    ),
    /tmpfs mount does not take "mode"/,
  );
  assert.match(
    failure(template("{kind: tmpfs, destination: /scratch, volume: cache}")),
    /tmpfs mount does not take "volume"/,
  );
  // A volume mount requires both its name and destination.
  assert.match(
    failure(template("{kind: volume, volume: cache}")),
    /destination: expected an absolute, clean destination/,
  );
  assert.match(
    failure(template("{kind: volume, destination: /cache}")),
    /volume: expected a string/,
  );
  assert.match(
    failure(
      template(
        "{kind: volume, volume: cache, destination: /cache, mode: nope}",
      ),
    ),
    /invalid mount mode/,
  );
});

test("a project mount takes a mode, defaulting to the editor's read_only", () => {
  const template = (mode: string): string =>
    `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  mounts:
    - {kind: project, project: app${mode}}
`;
  // Omitting the mode is the same as the editor's new-mount default.
  assert.deepEqual(
    parseContainerTemplate(template("")).spec.mounts,
    [{ kind: "project", project: "app", mode: "read_only" }],
  );
  assert.deepEqual(
    parseContainerTemplate(template(", mode: read_only")).spec.mounts,
    [{ kind: "project", project: "app", mode: "read_only" }],
  );
  assert.deepEqual(
    parseContainerTemplate(template(", mode: read_write")).spec.mounts,
    [{ kind: "project", project: "app", mode: "read_write" }],
  );
  assert.match(
    failure(template(", mode: nope")),
    /invalid mount mode/,
  );
});

test("secret names, not values, are accepted everywhere", () => {
  const template = (secret: string): string =>
    `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  secretEnv: {TOKEN: ${secret}}
`;
  assert.equal(
    parseContainerTemplate(template("github-token")).spec.secretEnv.TOKEN,
    "github-token",
  );
  assert.match(failure(template("bad name")), /invalid secret name/);
  assert.match(failure(template("bad/name")), /invalid secret name/);
});

test("a variable name cannot be both a plain and a secret env variable", () => {
  const text = `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  env: {TOKEN: visible}
  secretEnv: {TOKEN: token}
`;
  assert.match(failure(text), /used as both/);
});

test("the git identity variables are ignored rather than accepted", () => {
  const template = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  env: {GIT_AUTHOR_NAME: "John Doe", KEEP: "1"}
  secretEnv: {GIT_COMMITTER_EMAIL: github-token}
`);
  assert.deepEqual({ ...template.spec.env }, { KEEP: "1" });
  assert.deepEqual({ ...template.spec.secretEnv }, {});
  const yaml = renderContainerTemplate(template);
  assert.doesNotMatch(yaml, /GIT_(AUTHOR|COMMITTER)_/);
});

test("ports require an explicit tcp protocol and valid ports", () => {
  const template = (port: string): string =>
    `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  ports:
    - ${port}
`;
  assert.deepEqual(
    parseContainerTemplate(template("{container: 8080, protocol: tcp}")).spec
      .ports,
    [{ container: 8080, protocol: "tcp" }],
  );
  assert.match(
    failure(template("{container: 8080}")),
    /protocol is required/,
  );
  assert.match(
    failure(template("{container: 8080, protocol: udp}")),
    /only tcp is implemented/,
  );
  assert.match(
    failure(template("{container: 0, protocol: tcp}")),
    /container port must be an integer/,
  );
  assert.match(
    failure(template("{container: 8080, host: 80, protocol: tcp}")),
    /host port must be an integer between 1024 and 65535/,
  );
});

test("PATH additions must be absolute and clean", () => {
  const template = (path: string): string =>
    `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  paths: [${path}]
`;
  assert.deepEqual(
    parseContainerTemplate(template("/usr/local/bin")).spec.paths,
    ["/usr/local/bin"],
  );
  assert.match(failure(template("relative/bin")), /absolute, clean directory/);
  assert.match(failure(template("/opt/../bin")), /absolute, clean directory/);
  assert.match(failure(template("/opt/a:b")), /must not contain/);
});

test("parse rejects an empty document, multiple documents and malformed YAML", () => {
  assert.match(failure(""), /empty/);
  assert.match(
    failure(`${MINIMAL}---\n${MINIMAL}`),
    /only one YAML document/,
  );
  assert.match(failure("version: [1\n"), /invalid YAML/);
});

test("rendering is canonical and round-trips through the parser", () => {
  const template = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  env: {NODE_ENV: development, EMPTY: ""}
  secretEnv: {GITHUB_TOKEN: github-token}
  mounts:
    - {kind: project, project: app}
    - {kind: volume, volume: cache, destination: /cache, mode: read_write}
    - {kind: secret, secret: npm-token, destination: /root/.npmrc}
    - {kind: tmpfs, destination: /tmp/scratch}
  paths: [/usr/local/bin]
  ports:
    - {container: 8080, host: 8080, protocol: tcp}
    - {container: 3000, protocol: tcp}
`);
  const yaml = renderContainerTemplate(template);
  assert.equal(
    yaml,
    `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  env:
    EMPTY: ""
    NODE_ENV: development
  secretEnv:
    GITHUB_TOKEN: github-token
  mounts:
    - kind: project
      project: app
      mode: read_only
    - kind: volume
      volume: cache
      destination: /cache
      mode: read_write
    - kind: secret
      secret: npm-token
      destination: /root/.npmrc
    - kind: tmpfs
      destination: /tmp/scratch
  paths:
    - /usr/local/bin
  ports:
    - container: 8080
      host: 8080
      protocol: tcp
    - container: 3000
      protocol: tcp
`,
  );
  assert.deepEqual(parseContainerTemplate(yaml), template);
});

test("a flow-style template parses and the export renders block style", () => {
  const template = parseContainerTemplate(
    `version: 1
kind: dsh-podman/container-template
spec: {image: ubuntu, env: {NODE_ENV: development}, mounts: [{kind: project, project: app}, {kind: volume, volume: cache, destination: /cache, mode: read_write}], paths: [/usr/local/bin], ports: [{container: 8080, protocol: tcp}]}
`,
  );
  const yaml = renderContainerTemplate(template);
  assert.equal(
    yaml,
    `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  env:
    NODE_ENV: development
  mounts:
    - kind: project
      project: app
      mode: read_only
    - kind: volume
      volume: cache
      destination: /cache
      mode: read_write
  paths:
    - /usr/local/bin
  ports:
    - container: 8080
      protocol: tcp
`,
  );
  // Flow punctuation never survives into a rendered document.
  for (const punctuation of ["{", "}", "[", "]"]) {
    assert.ok(
      !yaml.includes(punctuation),
      `rendered YAML contains ${punctuation}`,
    );
  }
  assert.ok(yaml.endsWith("\n"));
  assert.deepEqual(parseContainerTemplate(yaml), template);
});

test("validateTemplate applies the same rules to a structured value", () => {
  assert.throws(
    () => validateTemplate({ version: 1, kind: "other", spec: {} }),
    /unsupported kind/,
  );
});

test("a template image id is the sanitized basename plus 8 hex of sha256(path)", async () => {
  const digest = await sha256Hex("/projects/app/.dsh-podman/Web Dev.yml");
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    await templateImageId("Web Dev", "/projects/app/.dsh-podman/Web Dev.yml"),
    `template-Web-Dev-${digest.slice(0, 8)}`,
  );
  assert.equal(
    templateImageIdFromDigest("web.yml", "ABCDEF0123456789"),
    "template-web-abcdef01",
  );
  assert.equal(sanitizedTemplateName("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizedTemplateName(".yml"), "template");
});

test("the image plan reuses a matching image and rebuilds a changed one", () => {
  const effective = {
    kind: "template" as const,
    base: "ubuntu" as const,
    packages: ["jq"],
  };
  const images = [
    { imageId: "template-web-12345678", parent: "ubuntu", packages: ["jq"] },
  ];
  assert.deepEqual(
    templateImagePlan(effective, "template-web-12345678", images),
    {
      effective,
      imageId: "template-web-12345678",
      builtAt: "",
      present: true,
      rebuild: false,
      needsBuild: false,
      reason: "ready",
    },
  );
  assert.equal(
    templateImagePlan(effective, "template-web-12345678", []).reason,
    "missing",
  );
  assert.equal(
    templateImagePlan(
      { ...effective, packages: ["jq", "yq"] },
      "template-web-12345678",
      images,
    ).reason,
    "packages",
  );
  assert.equal(
    templateImagePlan(
      { ...effective, base: "alpine" },
      "template-web-12345678",
      images,
    ).reason,
    "parent",
  );
  assert.deepEqual(
    templateImagePlan(
      { kind: "base", base: "ubuntu" },
      "template-web-12345678",
      images,
    ),
    {
      effective: { kind: "base", base: "ubuntu" },
      imageId: "ubuntu",
      builtAt: "",
      present: false,
      rebuild: false,
      needsBuild: true,
      reason: "missing",
    },
  );
});

test("the image plan reads a base-only template's own base record", () => {
  const effective = { kind: "base" as const, base: "ubuntu" as const };
  const builtAt = "2026-10-20T14:16:39Z";
  const base = {
    imageId: "ubuntu",
    parent: "",
    packages: [],
    builtAt,
  };
  // A base podman stores is ready, whether it was built locally or pulled; its
  // own record dates the plan.
  for (const status of ["built", "pulled"]) {
    assert.deepEqual(
      templateImagePlan(effective, "template-web-12345678", [{
        ...base,
        status,
      }]),
      {
        effective,
        imageId: "ubuntu",
        builtAt,
        present: true,
        rebuild: false,
        needsBuild: false,
        reason: "ready",
      },
    );
  }
  // A base that was never provisioned is a build, not a ready image.
  assert.deepEqual(
    templateImagePlan(effective, "template-web-12345678", [{
      ...base,
      status: "missing",
    }]),
    {
      effective,
      imageId: "ubuntu",
      builtAt: "",
      present: false,
      rebuild: false,
      needsBuild: true,
      reason: "missing",
    },
  );
  // A base absent from the list has no image to run either.
  assert.deepEqual(
    templateImagePlan(effective, "template-web-12345678", []),
    {
      effective,
      imageId: "ubuntu",
      builtAt: "",
      present: false,
      rebuild: false,
      needsBuild: true,
      reason: "missing",
    },
  );
});

test("the image plan builds a custom record the orchestrator marks missing", () => {
  const effective = {
    kind: "template" as const,
    base: "ubuntu" as const,
    packages: ["jq"],
  };
  const imageId = "template-web-12345678";
  const listed = { imageId, parent: "ubuntu", packages: ["jq"] };
  // podman no longer stores the image but the custom record survives: the plan
  // must offer a build, exactly as if the id were absent, and must not claim
  // the recipe is reusable.
  assert.deepEqual(
    templateImagePlan(effective, imageId, [{ ...listed, status: "missing" }]),
    {
      effective,
      imageId,
      builtAt: "",
      present: false,
      rebuild: false,
      needsBuild: true,
      reason: "missing",
    },
  );
  // A record whose image really is stored and whose recipe matches stays ready.
  assert.deepEqual(
    templateImagePlan(effective, imageId, [{ ...listed, status: "built" }]),
    {
      effective,
      imageId,
      builtAt: "",
      present: true,
      rebuild: false,
      needsBuild: false,
      reason: "ready",
    },
  );
  // An id the list does not mention still needs a build.
  assert.deepEqual(
    templateImagePlan(effective, imageId, []),
    {
      effective,
      imageId,
      builtAt: "",
      present: false,
      rebuild: false,
      needsBuild: true,
      reason: "missing",
    },
  );
  // "missing" wins over a recipe mismatch: there is nothing to compare with.
  assert.equal(
    templateImagePlan(effective, imageId, [{
      ...listed,
      parent: "alpine",
      status: "missing",
    }]).reason,
    "missing",
  );
});

test("the image plan carries the listed image's build time", () => {
  const effective = {
    kind: "template" as const,
    base: "ubuntu" as const,
    packages: ["jq"],
  };
  const imageId = "template-web-12345678";
  const builtAt = "2026-10-20T14:16:39Z";
  const listed = { imageId, parent: "ubuntu", packages: ["jq"], builtAt };
  // A usable record dates the plan, so the popup shows Built … without asking
  // the image list again.
  assert.equal(
    templateImagePlan(effective, imageId, [listed]).builtAt,
    builtAt,
  );
  // A recipe mismatch still names the existing image's build moment.
  assert.equal(
    templateImagePlan({ ...effective, packages: ["jq", "yq"] }, imageId, [
      listed,
    ]).builtAt,
    builtAt,
  );
  // A stale record is not an image: there is no build moment to show.
  assert.equal(
    templateImagePlan(effective, imageId, [{
      ...listed,
      status: "missing",
    }]).builtAt,
    "",
  );
  // A base-only template takes the base image's own record once that record
  // says podman stores it.
  assert.equal(
    templateImagePlan(
      { kind: "base", base: "ubuntu" },
      imageId,
      [{
        imageId: "ubuntu",
        parent: "",
        packages: [],
        status: "built",
        builtAt,
      }],
    ).builtAt,
    builtAt,
  );
  // A missing base has no build moment to show, even if its record carries one.
  assert.equal(
    templateImagePlan(
      { kind: "base", base: "ubuntu" },
      imageId,
      [{
        imageId: "ubuntu",
        parent: "",
        packages: [],
        status: "missing",
        builtAt,
      }],
    ).builtAt,
    "",
  );
  assert.equal(
    templateImagePlan({ kind: "base", base: "ubuntu" }, imageId, []).builtAt,
    "",
  );
});

test("export walks the parent chain and subtracts the base's built-ins", () => {
  const images = [
    { imageId: "base-custom", parent: "ubuntu", packages: ["neovim"] },
    { imageId: "child", parent: "base-custom", packages: ["yq"] },
  ];
  assert.deepEqual(templateExportImage("child", images), {
    kind: "template",
    base: "ubuntu",
    packages: ["neovim", "yq"],
  });
  // A custom image whose packages are all built-ins exports as the base.
  assert.deepEqual(
    templateExportImage("only-builtins", [
      {
        imageId: "only-builtins",
        parent: "ubuntu",
        packages: ["git", "curl"],
      },
    ]),
    { kind: "base", base: "ubuntu" },
  );
  assert.deepEqual(templateExportImage("archlinux", []), {
    kind: "base",
    base: "archlinux",
  });
  assert.throws(
    () => templateExportImage("missing", images),
    /is not listed/,
  );
});

test("exporting a container writes imageTemplate, mounts and explicit tcp ports", () => {
  const { filename, template, yaml } = exportContainerTemplate(
    {
      containerName: "dev",
      imageId: "child",
      env: { NODE_ENV: "development" },
      secretEnv: { GITHUB_TOKEN: "github-token" },
      mounts: [
        { kind: "tmpfs", destination: "/tmp/scratch", mode: "read_write" },
        {
          kind: "secret",
          secret: "npm-token",
          destination: "/root/.npmrc",
          mode: "read_only",
        },
        {
          kind: "volume",
          volume: "cache",
          destination: "/cache",
          mode: "read_write",
        },
        {
          kind: "project",
          projectName: "app",
          destination: "/projects/app",
          mode: "read_write",
        },
      ],
      paths: ["/usr/local/bin"],
      publishedPorts: [
        { port: 8080, hostPort: 8080, protocol: "tcp" },
        { port: 3000, hostPort: 0, protocol: "tcp" },
      ],
    },
    [
      { imageId: "base-custom", parent: "ubuntu", packages: ["neovim"] },
      { imageId: "child", parent: "base-custom", packages: ["yq"] },
    ],
  );
  assert.equal(filename, "dev.yml");
  assert.deepEqual(template.spec.imageTemplate, {
    base: "ubuntu",
    packages: ["neovim", "yq"],
  });
  assert.deepEqual(template.spec.mounts, [
    { kind: "project", project: "app", mode: "read_write" },
    {
      kind: "volume",
      volume: "cache",
      destination: "/cache",
      mode: "read_write",
    },
    { kind: "secret", secret: "npm-token", destination: "/root/.npmrc" },
    { kind: "tmpfs", destination: "/tmp/scratch" },
  ]);
  assert.deepEqual(template.spec.ports, [
    { container: 8080, host: 8080, protocol: "tcp" },
    { container: 3000, protocol: "tcp" },
  ]);
  assert.match(yaml, /imageTemplate:/);
  assert.match(yaml, /protocol: tcp/);
});

test("export accepts a project mount without a destination and normalises proto kinds", () => {
  // A live container row carries the control plane's enum spelling: a project
  // mount has no destination on the wire, and the volume's kind is an enum too.
  const { filename, template, yaml } = exportContainerTemplate(
    {
      containerName: "default",
      imageId: "ubuntu",
      mounts: [
        { kind: "MOUNT_KIND_PROJECT", projectName: "app", mode: "read_only" },
        {
          kind: "MOUNT_KIND_VOLUME",
          volume: "cache",
          destination: "/cache",
          mode: "read_write",
        },
      ],
      publishedPorts: [],
    },
    [],
    "app",
  );
  assert.equal(filename, "default.yml");
  assert.deepEqual(template.spec.mounts, [
    { kind: "project", project: "app", mode: "read_only" },
    {
      kind: "volume",
      volume: "cache",
      destination: "/cache",
      mode: "read_write",
    },
  ]);
  // The rendered document names the project mount without a destination and
  // round-trips through the parser.
  assert.equal(
    yaml,
    `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  mounts:
    - kind: project
      project: app
      mode: read_only
    - kind: volume
      volume: cache
      destination: /cache
      mode: read_write
`,
  );
  assert.deepEqual(
    parseContainerTemplate(yaml).spec.mounts,
    template.spec.mounts,
  );
});

test("export still refuses a volume mount without a destination", () => {
  assert.throws(
    () =>
      exportContainerTemplate(
        {
          containerName: "default",
          imageId: "ubuntu",
          mounts: [{ kind: "volume", volume: "cache" }],
          publishedPorts: [],
        },
        [],
      ),
    /container "default" has a mount without a valid destination/,
  );
});

test("mounts group by the card kind order and keep their order within a kind", () => {
  const { template, yaml } = exportContainerTemplate(
    {
      containerName: "dev",
      imageId: "ubuntu",
      mounts: [
        { kind: "tmpfs", destination: "/tmp/b" },
        { kind: "volume", volume: "second", destination: "/second" },
        { kind: "secret", secret: "s", destination: "/s" },
        { kind: "volume", volume: "first", destination: "/first" },
        { kind: "project", projectName: "z" },
        { kind: "tmpfs", destination: "/tmp/a" },
        { kind: "project", projectName: "a" },
      ],
      publishedPorts: [],
    },
    [],
  );
  assert.deepEqual(
    template.spec.mounts.map((mount) => mount.kind),
    [
      "project",
      "project",
      "volume",
      "volume",
      "secret",
      "tmpfs",
      "tmpfs",
    ],
  );
  assert.deepEqual(
    template.spec.mounts.filter((mount) => mount.kind === "project").map(
      (mount) => (mount.kind === "project" ? mount.project : ""),
    ),
    ["z", "a"],
  );
  assert.deepEqual(
    template.spec.mounts.filter((mount) => mount.kind === "volume").map(
      (mount) => (mount.kind === "volume" ? mount.volume : ""),
    ),
    ["second", "first"],
  );
  // The rendered document follows the same order, one mount at a time.
  assert.match(
    yaml,
    /^  mounts:\n    - kind: project\n      project: z\n      mode: read_only\n    - kind: project\n      project: a\n      mode: read_only\n/m,
  );
  assert.deepEqual(
    parseContainerTemplate(yaml).spec.mounts,
    template.spec.mounts,
  );
});

test("export starts a default container's mounts with its primary project mount", () => {
  const { template, yaml } = exportContainerTemplate(
    {
      containerName: "default",
      imageId: "ubuntu",
      mounts: [
        { kind: "tmpfs", destination: "/tmp/scratch" },
        { kind: "volume", volume: "cache", destination: "/cache" },
        { kind: "secret", secret: "npm-token", destination: "/root/.npmrc" },
        { kind: "project", projectName: "other" },
        { kind: "project", projectName: "app", mode: "read_write" },
      ],
      publishedPorts: [],
    },
    [],
    "app",
  );
  assert.deepEqual(
    template.spec.mounts.map((mount) => mount.kind),
    ["project", "project", "volume", "secret", "tmpfs"],
  );
  assert.deepEqual(
    template.spec.mounts.filter((mount) => mount.kind === "project").map(
      (mount) => (mount.kind === "project" ? mount.project : ""),
    ),
    ["app", "other"],
  );
  // The primary mount was last in the input, and the rendered document still
  // opens with it.
  assert.match(
    yaml,
    /^  mounts:\n    - kind: project\n      project: app\n      mode: read_write\n/m,
  );
  assert.deepEqual(
    parseContainerTemplate(yaml).spec.mounts,
    template.spec.mounts,
  );
});

test("export keeps a named container's project mounts in order after the primary", () => {
  const { template, yaml } = exportContainerTemplate(
    {
      containerName: "web",
      imageId: "ubuntu",
      mounts: [
        { kind: "project", projectName: "z" },
        { kind: "project", projectName: "app" },
        { kind: "project", projectName: "a" },
        { kind: "volume", volume: "cache", destination: "/cache" },
      ],
      publishedPorts: [],
    },
    [],
    "app",
  );
  assert.deepEqual(
    template.spec.mounts.filter((mount) => mount.kind === "project").map(
      (mount) => (mount.kind === "project" ? mount.project : ""),
    ),
    ["app", "z", "a"],
  );
  assert.match(
    yaml,
    /^  mounts:\n    - kind: project\n      project: app\n      mode: read_only\n    - kind: project\n      project: z\n      mode: read_only\n    - kind: project\n      project: a\n      mode: read_only\n    - kind: volume\n/m,
  );
  assert.deepEqual(
    parseContainerTemplate(yaml).spec.mounts,
    template.spec.mounts,
  );
});

test("export drops the git identity variables from env and secretEnv", () => {
  const { template, yaml } = exportContainerTemplate(
    {
      containerName: "dev",
      imageId: "ubuntu",
      env: {
        GIT_AUTHOR_NAME: "John Doe",
        GIT_AUTHOR_EMAIL: "john.doe@git.example",
        GIT_COMMITTER_NAME: "John Doe",
        GIT_COMMITTER_EMAIL: "john.doe@git.example",
        KEEP: "1",
      },
      secretEnv: {
        GIT_AUTHOR_NAME: "github-token",
        TOKEN: "github-token",
      },
      mounts: [],
      publishedPorts: [],
    },
    [],
  );
  assert.deepEqual({ ...template.spec.env }, { KEEP: "1" });
  assert.deepEqual({ ...template.spec.secretEnv }, { TOKEN: "github-token" });
  assert.doesNotMatch(yaml, /GIT_(AUTHOR|COMMITTER)_/);
  assert.match(yaml, /^ {4}KEEP: "1"$/m);
});

test("exporting a custom image that only holds base packages writes image:", () => {
  const { template, yaml } = exportContainerTemplate(
    {
      containerName: "web",
      imageId: "only-builtins",
      mounts: [],
      publishedPorts: [],
    },
    [
      {
        imageId: "only-builtins",
        parent: "ubuntu",
        packages: ["git", "curl"],
      },
    ],
  );
  assert.equal(template.spec.image, "ubuntu");
  assert.equal(template.spec.imageTemplate, undefined);
  assert.match(yaml, /^  image: ubuntu$/m);
  assert.doesNotMatch(yaml, /imageTemplate/);
});

test("requirements name missing projects, secrets and volumes", () => {
  const template = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  secretEnv: {TOKEN: github-token, OTHER: github-token}
  mounts:
    - {kind: project, project: missing}
    - {kind: project, project: present}
    - {kind: volume, volume: cache, destination: /cache}
    - {kind: volume, volume: logs, destination: /logs}
    - {kind: volume, volume: cache, destination: /cache-again}
    - {kind: secret, secret: npm-token, destination: /root/.npmrc}
`);
  assert.deepEqual(
    templateRequirements(template, {
      projectExists: (project) => project === "present",
      secrets: ["npm-token"],
      volumes: ["logs"],
    }),
    [
      { kind: "project_missing", project: "missing", path: "missing" },
      { kind: "secret_env_missing", env: "TOKEN", secret: "github-token" },
      { kind: "secret_env_missing", env: "OTHER", secret: "github-token" },
      { kind: "volume_missing", volume: "cache" },
    ],
  );
  // A volume is reported only while it is absent, and its two mounts share one
  // warning; a template that mounts no volume reports none.
  assert.deepEqual(
    templateRequirements(template, { volumes: ["cache", "logs"] }),
    [],
  );
  const plain = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
`);
  assert.deepEqual(templateRequirements(plain, { volumes: [] }), []);
});
