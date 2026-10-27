// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Reading a project's container templates on the dsh host. The host-side
// project view is read-only (the dsh container mounts the projects root that
// way), so this module only lists and reads; saving goes through the guest
// write RPC. It is the file half of the same host listing the workspace
// directory picker uses: no orchestrator call and no container is involved.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeProjectPath,
  TEMPLATE_DIRECTORY,
  TEMPLATE_EXTENSION,
} from "./container-template.js";
import { projectNameFromHostPath } from "./project-path.js";
import { workspaceSlug } from "./workspace-binding.js";

// A template larger than this is refused rather than read into memory: a
// template is a small configuration document.
export const MAX_TEMPLATE_BYTES = 1 << 20;

export interface ProjectTemplateFile {
  // The file's name, including its .yml/.yaml suffix.
  name: string;
  // The file's absolute host path.
  path: string;
  yaml: string;
}

export class TemplateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateFileError";
  }
}

// templateFileName validates a template name as one plain basename and returns
// the file name to read or write. A name without a YAML suffix gets the
// canonical ".yml" one; a name with one keeps it. Traversal, hidden files and
// separators are refused here, so every caller shares the rule (the guest agent
// enforces the same one).
export function templateFileName(name: unknown): string {
  if (typeof name !== "string" || name === "") {
    throw new TemplateFileError("template name is required");
  }
  if (name.length > 200) {
    throw new TemplateFileError(
      `template name ${JSON.stringify(name)} is too long`,
    );
  }
  if (/[/\\\0\n\r]/.test(name)) {
    throw new TemplateFileError(
      `template name ${
        JSON.stringify(name)
      } must be a plain basename with no path separators`,
    );
  }
  if (name === "." || name === ".." || name.startsWith(".")) {
    throw new TemplateFileError(
      `template name ${JSON.stringify(name)} must be a plain basename`,
    );
  }
  return /\.(?:ya?ml)$/i.test(name) ? name : `${name}${TEMPLATE_EXTENSION}`;
}

// templateDisplayName drops the YAML suffix, the name a popup shows.
export function templateDisplayName(name: string): string {
  return name.replace(/\.(?:ya?ml)$/i, "");
}

// templateDirectory is the directory templates live in, below a project root.
export function templateDirectory(projectPath: string): string {
  return join(projectPath, TEMPLATE_DIRECTORY);
}

// templatePathForName resolves a template name to the absolute path it reads
// from and the guest RPC writes to. The name was already reduced to one
// basename, so the join cannot escape the template directory.
export function templatePathForName(
  projectPath: string,
  name: unknown,
): string {
  return join(templateDirectory(projectPath), templateFileName(name));
}

// listProjectTemplates lists the readable YAML templates of one project,
// sorted by file name. A missing .dsh-podman directory is an empty list, not an
// error: no template was saved yet. Directories, hidden files and symlinks are
// skipped, so listing never follows a link out of the project.
export async function listProjectTemplates(
  projectPath: string,
): Promise<ProjectTemplateFile[]> {
  const directory = templateDirectory(projectPath);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw new TemplateFileError(
      `cannot list ${directory}: ${errorMessage(error)}`,
    );
  }
  const names = entries
    .filter((entry) =>
      entry.isFile() && !entry.name.startsWith(".") &&
      /\.(?:ya?ml)$/i.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const templates: ProjectTemplateFile[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_TEMPLATE_BYTES) continue;
      templates.push({
        name,
        path,
        yaml: await readFile(path, "utf8"),
      });
    } catch {
      // An entry that vanished or cannot be read is skipped; the listing still
      // serves every other template.
    }
  }
  return templates;
}

// readProjectTemplate reads one named template, refusing anything but a
// regular, bounded file.
export async function readProjectTemplate(
  projectPath: string,
  name: unknown,
): Promise<ProjectTemplateFile> {
  const file = templateFileName(name);
  const path = join(templateDirectory(projectPath), file);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (isMissing(error)) {
      throw new TemplateFileError(
        `template ${JSON.stringify(file)} not found in ${TEMPLATE_DIRECTORY}`,
      );
    }
    throw new TemplateFileError(
      `cannot read template ${JSON.stringify(file)}: ${errorMessage(error)}`,
    );
  }
  if (!info.isFile()) {
    throw new TemplateFileError(
      `template ${JSON.stringify(file)} is not a regular file`,
    );
  }
  if (info.size > MAX_TEMPLATE_BYTES) {
    throw new TemplateFileError(
      `template ${JSON.stringify(file)} is too large`,
    );
  }
  return { name: file, path, yaml: await readFile(path, "utf8") };
}

// projectDirectoryExists reports whether a project path names an existing
// directory under the projects root. It is the check behind the load popup's
// warning about a project mount whose directory was removed.
export async function projectDirectoryExists(
  projectsRoot: string,
  project: string,
): Promise<boolean> {
  const name = normalizeProjectPath(project);
  if (name === undefined) return false;
  const root = projectsRoot.replace(/\/+$/, "");
  if (root === "") return false;
  const path = join(root, name);
  if (path !== `${root}/${name}`) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// workspaceForCwd resolves the dsh workspace that owns a session working
// directory, the same lookup the tools and the terminal use.
export async function workspaceForCwd(
  registry: any,
  projectsRoot: string,
  cwd: unknown,
): Promise<RegisteredWorkspace> {
  if (typeof cwd !== "string" || cwd === "") {
    throw new TemplateFileError(
      `cannot resolve a workspace without a session working directory (got ${
        JSON.stringify(cwd)
      })`,
    );
  }
  const workspace = await registry?.resolveByPath?.(cwd);
  if (workspace === undefined) {
    throw new TemplateFileError(
      `no workspace owns session directory ${JSON.stringify(cwd)}`,
    );
  }
  const projectPath = String(workspace.path ?? "");
  const projectName = projectNameFromHostPath(projectsRoot, projectPath);
  if (projectName === undefined) {
    throw new TemplateFileError(
      `workspace ${
        JSON.stringify(workspaceSlug(workspace.id))
      } is not under the projects root`,
    );
  }
  return {
    workspaceSlug: workspaceSlug(workspace.id),
    projectName,
    projectPath,
  };
}

// RegisteredWorkspace is the part of a dsh workspace this module needs.
export interface RegisteredWorkspace {
  workspaceSlug: string;
  projectName: string;
  projectPath: string;
}

// workspaceForSlug resolves a registered dsh workspace by its slug. The project
// name is its path relative to the projects root, which is the value a project
// mount stores; a workspace outside the root is refused rather than mounted
// with an absolute name.
export function workspaceForSlug(
  registry: any,
  projectsRoot: string,
  slug: string,
): RegisteredWorkspace {
  if (slug === "") throw new TemplateFileError("a workspace is required");
  for (const workspace of registry?.list?.() ?? []) {
    if (workspaceSlug(workspace.id) !== slug) continue;
    const projectPath = String(workspace.path ?? "");
    const projectName = projectNameFromHostPath(projectsRoot, projectPath);
    if (projectName === undefined) {
      throw new TemplateFileError(
        `workspace ${JSON.stringify(slug)} is not under the projects root`,
      );
    }
    return { workspaceSlug: slug, projectName, projectPath };
  }
  throw new TemplateFileError(`unknown workspace ${JSON.stringify(slug)}`);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
