// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  type ExecIdentity,
  bytesText,
  currentCwd,
  guestCwd,
  outputLines,
  resolveGuestPath,
  resolveToolBinding,
  runExec,
  sessionWorkspaceSlug,
  sliceLines,
  unaryGuest,
  writeGuestFile,
} from "./guest-rpc.js";
import { inferMountKind, mountsFromInput, projectMountDestinationReason } from "./mount-input.js";
import { publicContainer, publicDaemon, publicImage, publicMount } from "./public.js";
import { grpc } from "./grpc/runtime-client.js";
import { defaultMountMode, mountKindToProto, mountModeToProto } from "./mount-enums.js";
import {
  WorkspaceResolver,
  containerNotFound,
  metadata,
  workspaceSlug,
} from "./workspace-binding.js";

// Cap on paths `container_glob` returns, matching the built-in glob tool's
// default result limit; `--sort=modified` makes the retained head the newest.
const GLOB_MAX_RESULTS = 100;

// VCS metadata directories ripgrep must never descend into for a discovery
// listing (`--no-ignore --hidden` would otherwise surface them).
const GLOB_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

// failOnSearchError turns a ripgrep failure into a tool error: exit code 2 means
// ripgrep rejected the pattern or could not read the tree, and returning an
// empty result would present that as a successful search.
function failOnSearchError(
  tool: string,
  result: { exitCode: number; stderr: string },
): void {
  if (result.exitCode !== 2) return;
  const detail = result.stderr.trim();
  throw new Error(detail === "" ? `${tool} search failed (ripgrep exit code 2)` : detail);
}

// containerTarget resolves a container-scoped file target through the plugin's
// own filesystem provider, so the container file tools share the harness's file
// contracts (the read-before-write guard, the binary rejection, and the same
// diagnostics) instead of calling the guest directly.
async function containerTarget(
  ctx: any,
  path: string,
  container: string,
  exec: any,
): Promise<any> {
  return await ctx.fs.resolve(path, {
    cwd: currentCwd(exec),
    container: container ?? "",
    signal: exec?.signal,
  });
}

// identityFromInput validates the optional uid/gid/groups identity a tool
// accepts and returns it, or undefined when none was requested. Values are
// numeric only: the container's /etc/passwd is on the read-only rootfs, so
// there are no names to resolve.
function identityFromInput(input: any): ExecIdentity | undefined {
  const identity: ExecIdentity = {};
  if (input.uid !== undefined) {
    if (!Number.isInteger(input.uid) || input.uid < 0) {
      throw new Error("uid must be an integer >= 0");
    }
    identity.uid = input.uid;
  }
  if (input.gid !== undefined) {
    if (!Number.isInteger(input.gid) || input.gid < 0) {
      throw new Error("gid must be an integer >= 0");
    }
    identity.gid = input.gid;
  }
  if (input.groups !== undefined) {
    if (
      !Array.isArray(input.groups) ||
      input.groups.some(
        (group: unknown) => !Number.isInteger(group) || (group as number) < 0,
      )
    ) {
      throw new Error("groups must be an array of integers >= 0");
    }
    identity.groups = input.groups;
  }
  return identity.uid === undefined &&
    identity.gid === undefined &&
    identity.groups === undefined
    ? undefined
    : identity;
}

export const toolHandlers: Record<
  string,
  (
    resolver: WorkspaceResolver,
    input: any,
    exec: any,
    ctx?: any,
  ) => Promise<unknown>
> = {
  image_list: async (resolver) => {
    const result = await resolver.control<{ images?: any[] }>("listImages", {});
    return (result.images ?? []).map(publicImage);
  },
  image_get: async (resolver, input) =>
    publicImage(
      await resolver.control("getImage", { imageId: input.imageId }),
    ),
  image_build: async (resolver, input) =>
    publicImage(
      await resolver.control("buildImage", {
        imageId: input.imageId,
        parent: input.parent,
        packages: input.packages,
      }),
    ),
  image_rebuild: async (resolver, input) =>
    publicImage(
      await resolver.control("rebuildImage", { imageId: input.imageId }),
    ),
  image_rebuild_all: async (resolver) => {
    const result = await resolver.control<{ rebuilt?: string[]; skipped?: string[] }>(
      "rebuildAllImages",
      {},
    );
    return {
      rebuilt: result.rebuilt ?? [],
      skipped: result.skipped ?? [],
    };
  },
  image_remove: async (resolver, input) => {
    await resolver.control("removeImage", { imageId: input.imageId });
    return { removed: input.imageId };
  },
  container_list: async (resolver, _input, exec) => {
    const slug = await sessionWorkspaceSlug(resolver, currentCwd(exec));
    const result = await resolver.control<{ containers?: any[] }>(
      "listContainers",
      {},
    );
    const rows = (result.containers ?? []).filter(
      (row: any) => row.workspaceSlug === slug,
    );
    const defaultRow = rows.find((row: any) => row.containerName === "default");
    const listed = defaultRow === undefined
      ? [{ containerName: "default", status: "not started" }]
      : [publicContainer(defaultRow)];
    return [
      ...listed,
      ...rows
        .filter((row: any) => row.containerName !== "default")
        .map(publicContainer),
    ];
  },
  container_start: async (resolver, input, exec) => {
    const mounts = mountsFromInput(input.mounts, resolver.getConfig().projectsRoot);
    const row = await resolver.control("startContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      imageId: input.image,
      ...(mounts === undefined ? {} : { mounts }),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.secretEnv !== undefined ? { secretEnv: input.secretEnv } : {}),
      ...(input.paths !== undefined ? { paths: input.paths } : {}),
    });
    return publicContainer(row);
  },
  container_recreate: async (resolver, input, exec) => {
    const mounts = mountsFromInput(input.mounts, resolver.getConfig().projectsRoot);
    const row = await resolver.control("recreateContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      imageId: input.image ?? "",
      ...(mounts === undefined ? {} : { mounts }),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.secretEnv !== undefined ? { secretEnv: input.secretEnv } : {}),
      ...(input.paths !== undefined ? { paths: input.paths } : {}),
    });
    return publicContainer(row);
  },
  container_remove: async (resolver, input, exec) => {
    await resolver.control("removeContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
    });
    return { removed: input.container };
  },
  container_bash: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    return runExec(
      binding,
      ["bash", "-c", input.command],
      guestCwd(input.workdir, sessionCwd, binding),
      input.env,
      input.timeoutMs,
      identityFromInput(input),
    );
  },
  container_exec: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    return runExec(
      binding,
      input.argv,
      guestCwd(input.workdir, sessionCwd, binding),
      input.env,
      input.timeoutMs,
      identityFromInput(input),
    );
  },
  container_read: async (resolver, input, exec, ctx) => {
    const target = await containerTarget(ctx, input.file_path, input.container, exec);
    const content = await ctx.fs.readText(target, exec?.signal);
    return sliceLines(content, input.offset, input.limit);
  },
  container_write: async (resolver, input, exec, ctx) => {
    const target = await containerTarget(ctx, input.file_path, input.container, exec);
    // The harness's write tool computes the intent through this waterfall and
    // the provider enforces it, so the container tool shares the same
    // read-before-write guard and diagnostics.
    const intent = await ctx.waterfall("fs/write-intent", target, exec, () => undefined);
    const content = String(input.content ?? "");
    const outcome = await ctx.fs.writeText(target, content, intent, exec?.signal);
    ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
    return { bytesWritten: Buffer.byteLength(content, "utf8") };
  },
  container_edit: async (resolver, input, exec, ctx) => {
    const target = await containerTarget(ctx, input.file_path, input.container, exec);
    const intent = await ctx.waterfall("fs/edit-intent", target, exec, () => undefined);
    const outcome = await ctx.fs.editText(
      target,
      {
        oldString: input.old_string,
        newString: input.new_string,
        replaceAll: input.replace_all === true,
      },
      intent,
      exec?.signal,
    );
    ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
    return { before: outcome.before, after: outcome.after };
  },
  container_glob: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const argv = [
      "rg",
      "--files",
      `--glob=${input.pattern}`,
      "--sort=modified",
      "--no-ignore",
      "--hidden",
      ...GLOB_VCS_EXCLUDES.flatMap((name) => [
        `--glob=!**/${name}`,
        `--glob=!**/${name}/**`,
      ]),
    ];
    const result = await runExec(
      binding,
      argv,
      guestCwd(input.path, sessionCwd, binding),
    );
    failOnSearchError("glob", result);
    const files = outputLines(result.stdout);
    const capped = files.length > GLOB_MAX_RESULTS;
    return {
      files: capped ? files.slice(0, GLOB_MAX_RESULTS) : files,
      ...(capped
        ? {
            note: `showing ${GLOB_MAX_RESULTS} of ${files.length} files in modification-time order; narrow pattern or path to see more`,
          }
        : {}),
    };
  },
  container_grep: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const cwd = guestCwd(undefined, sessionCwd, binding);
    // The search root: the requested path, else the container's default (the
    // session workspace when it is mounted). Ripgrep reads stdin instead of the
    // working directory when it is given no path, so it is always explicit.
    const root = guestCwd(input.path, sessionCwd, binding) ?? cwd;
    const argv = ["rg", "-n"];
    if (typeof input.include === "string" && input.include !== "") {
      argv.push("--glob", input.include);
    }
    argv.push(input.pattern);
    if (root !== undefined) argv.push(root);
    const result = await runExec(binding, argv, cwd);
    failOnSearchError("grep", result);
    return {
      matches: outputLines(result.stdout),
    };
  },
  container_mount_list: async (resolver, input, exec) => {
    const slug = await sessionWorkspaceSlug(resolver, currentCwd(exec));
    const result = await resolver.control<{ containers?: any[] }>(
      "listContainers",
      {},
    );
    const row = (result.containers ?? []).find(
      (candidate: any) =>
        candidate.workspaceSlug === slug &&
        candidate.containerName === input.container,
    );
    if (row === undefined) {
      throw containerNotFound(input.container, slug);
    }
    const mounts = row.mounts ?? [];
    return mounts.map(publicMount);
  },
  container_mount_add: async (resolver, input, exec) => {
    const kind = inferMountKind(input);
    const projectsRoot = resolver.getConfig().projectsRoot;
    const destinationReason = projectMountDestinationReason(projectsRoot, input);
    if (destinationReason !== undefined) throw new Error(destinationReason);
    if (kind === "secret" && input.mode === "read_write") {
      throw new Error(
        "secret mounts are read-only; omit mode or use read_only",
      );
    }
    const protoKind = mountKindToProto(kind);
    const mode = mountModeToProto(input.mode ?? defaultMountMode(kind));
    const request: Record<string, unknown> = {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      kind: protoKind,
    };
    if (kind === "volume") {
      request.volume = input.volume;
      request.destination = input.destination;
      request.mode = mode;
    } else if (kind === "tmpfs") {
      request.destination = input.destination;
      request.mode = mode;
    } else if (kind === "secret") {
      request.secret = input.secret;
      request.destination = input.destination;
    } else {
      request.project = input.project;
      request.mode = mode;
    }
    const row = await resolver.control("addContainerMount", request);
    return publicContainer(row);
  },
  container_mount_remove: async (resolver, input, exec) => {
    const kind = inferMountKind(input);
    const protoKind = mountKindToProto(kind);
    const request: Record<string, unknown> = {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      kind: protoKind,
    };
    if (kind === "project") {
      request.project = input.project;
    } else if (kind === "volume") {
      if (input.volume !== undefined) request.volume = input.volume;
    } else if (kind === "secret") {
      if (input.secret !== undefined) request.secret = input.secret;
    }
    if (kind !== "project" && input.destination !== undefined) {
      request.destination = input.destination;
    }
    const row = await resolver.control("removeContainerMount", request);
    return publicContainer(row);
  },
  container_mount_update: async (resolver, input, exec) => {
    const kind = inferMountKind(input);
    if (kind !== "project" && kind !== "volume") {
      throw new Error(
        `only project and volume mounts carry a mode; ${kind} mounts cannot be remounted`,
      );
    }
    const projectsRoot = resolver.getConfig().projectsRoot;
    const destinationReason = projectMountDestinationReason(projectsRoot, input);
    if (destinationReason !== undefined) throw new Error(destinationReason);
    const request: Record<string, unknown> = {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      kind: mountKindToProto(kind),
      mode: mountModeToProto(input.mode),
    };
    if (kind === "project") {
      request.project = input.project;
    } else {
      if (input.volume !== undefined) request.volume = input.volume;
      if (input.destination !== undefined) {
        request.destination = input.destination;
      }
    }
    const row = await resolver.control("updateContainerMount", request);
    return publicContainer(row);
  },
  container_path_set: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const slug = await sessionWorkspaceSlug(resolver, sessionCwd);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const paths = Array.isArray(input.paths) ? input.paths.map(String) : [];
    return {
      paths: await applyContainerPaths(resolver, binding, slug, input.container, paths),
    };
  },
  container_path_add: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const slug = await sessionWorkspaceSlug(resolver, sessionCwd);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const current = await containerPathState(binding);
    // Prepending gives the new path the highest priority; an existing entry is
    // moved to the front rather than duplicated.
    const paths = [
      input.path,
      ...current.paths.filter((path) => path !== input.path),
    ];
    return {
      paths: await applyContainerPaths(resolver, binding, slug, input.container, paths),
    };
  },
  container_path_remove: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const slug = await sessionWorkspaceSlug(resolver, sessionCwd);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const current = await containerPathState(binding);
    if (!current.paths.includes(input.path)) {
      if (current.defaultPaths.includes(input.path)) {
        throw new Error(
          `path ${JSON.stringify(input.path)} is part of the container's default PATH and cannot be removed`,
        );
      }
      throw new Error(
        `path ${JSON.stringify(input.path)} is not an added path`,
      );
    }
    const paths = current.paths.filter((path) => path !== input.path);
    return {
      paths: await applyContainerPaths(resolver, binding, slug, input.container, paths),
    };
  },
  volume_list: async (resolver) => {
    const result = await resolver.control<{ volumes?: any[] }>("listVolumes", {});
    return (result.volumes ?? []).map((volume: any) => ({ name: volume.name }));
  },
  volume_create: async (resolver, input) => {
    await resolver.control("createVolume", { name: input.name });
    return { name: input.name };
  },
  volume_remove: async (resolver, input) => {
    await resolver.control("removeVolume", { name: input.name });
    return { removed: input.name };
  },
  secret_list: async (resolver) => {
    const result = await resolver.control<{ secrets?: any[] }>("listSecrets", {});
    return (result.secrets ?? []).map((secret: any) => ({ name: secret.name }));
  },
  secret_create: async (resolver, input) => {
    await resolver.control("createSecret", {
      name: input.name,
      ...(input.length ? { length: input.length } : {}),
      ...(input.charset ? { charset: input.charset } : {}),
    });
    return { name: input.name };
  },
  secret_remove: async (resolver, input) => {
    await resolver.control("removeSecret", { name: input.name });
    return { removed: input.name };
  },
  container_secret_add: async (resolver, input, exec) => {
    const row = await resolver.control("addContainerSecret", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      env: input.env,
      secret: input.secret,
    });
    return publicContainer(row);
  },
  container_secret_remove: async (resolver, input, exec) => {
    const row = await resolver.control("removeContainerSecret", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      env: input.env,
    });
    return publicContainer(row);
  },
  daemon_start: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const request: Record<string, unknown> = {
      argv: input.argv,
      inheritEnv: { value: input.inheritEnv !== false },
    };
    if (input.name !== undefined) request.name = input.name;
    const cwd = guestCwd(input.cwd, sessionCwd, binding);
    if (cwd !== undefined) request.cwd = cwd;
    if (input.env !== undefined) request.env = input.env;
    const identity = identityFromInput(input);
    if (identity?.uid !== undefined) request.uid = { value: identity.uid };
    if (identity?.gid !== undefined) request.gid = { value: identity.gid };
    if (identity?.groups !== undefined) request.groups = identity.groups;
    const info = await unaryGuest({ binding }, "startDaemon", request);
    return publicDaemon(info);
  },
  daemon_list: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const result = (await unaryGuest(
      { binding },
      "listDaemons",
      {},
    )) as { daemons?: any[] };
    return (result.daemons ?? []).map(publicDaemon);
  },
  daemon_stop: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    await daemonCall(input.name, () =>
      unaryGuest({ binding }, "stopDaemon", {
        name: input.name,
        signal: input.signal,
      }),
    );
    return { stopped: input.name };
  },
  daemon_restart: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const info = await daemonCall(input.name, () =>
      unaryGuest({ binding }, "restartDaemon", { name: input.name }),
    );
    return publicDaemon(info);
  },
  daemon_logs: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const result = (await daemonCall(input.name, () =>
      unaryGuest({ binding }, "daemonLogs", {
        name: input.name,
        tailBytes: input.tailBytes,
      }),
    )) as { stdout?: unknown; stderr?: unknown };
    return {
      stdout: bytesText(result.stdout),
      stderr: bytesText(result.stderr),
    };
  },
};

function daemonNotFound(name: string): Error {
  const error = new Error(`daemon ${JSON.stringify(name)} not found`);
  (error as { code?: string }).code = "NOT_FOUND";
  return error;
}

// containerPathState reads the guest's live PATH additions and the default PATH
// they are prepended to.
async function containerPathState(binding: {
  guest: any;
  token: string;
}): Promise<{ paths: string[]; defaultPaths: string[] }> {
  const result = (await unaryGuest({ binding }, "getPaths", {})) as any;
  const paths = Array.isArray(result?.paths)
    ? result.paths.map((path: unknown) => String(path))
    : [];
  const defaultPath =
    typeof result?.defaultPath === "string" ? result.defaultPath : "";
  return {
    paths,
    defaultPaths: defaultPath === "" ? [] : defaultPath.split(":"),
  };
}

// applyContainerPaths persists the list on the container and pushes it to the
// running guest agent, returning the applied (validated, deduplicated) list.
// The guest holds the live list; the container record is what a recreate
// restores it from.
async function applyContainerPaths(
  resolver: any,
  binding: { guest: any; token: string },
  slug: string,
  container: string,
  paths: readonly string[],
): Promise<string[]> {
  const row = (await resolver.control("setContainerPaths", {
    workspaceSlug: slug,
    container,
    paths: [...paths],
  })) as any;
  const persisted = Array.isArray(row?.paths)
    ? row.paths.map((path: unknown) => String(path))
    : [...paths];
  const result = (await unaryGuest({ binding }, "setPaths", {
    paths: persisted,
  })) as any;
  return Array.isArray(result?.paths)
    ? result.paths.map((path: unknown) => String(path))
    : persisted;
}

// daemonCall maps the guest agent's generic "unknown daemon" to a message that
// names the daemon the caller asked about.
async function daemonCall<T>(name: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (
      (error as { code?: unknown }).code === grpc.status.NOT_FOUND &&
      /unknown daemon/.test((error as Error).message)
    ) {
      throw daemonNotFound(name);
    }
    throw error;
  }
}
