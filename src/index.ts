import { WorkspaceResolver } from './workspace-binding.js'
import { metadata } from './workspace-binding.js'
import { PassThrough } from 'node:stream'

function defineTool<T>(definition: T): T { return definition }
const toolOutput = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] }
const workspaceParameters = {
  workspace_slug: { type: 'string', required: true, description: 'Workspace slug.' },
  mounts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    project_name: { type: 'string', required: true },
    mode: { type: 'string', enum: ['read_only', 'read_write'], required: true },
  } } },
}
const packageParameters = { packages: { type: 'array', required: true, items: { type: 'string' } } }
const imageParameters = {
  image_id: { type: 'string', required: true },
  base_image: { type: 'string' },
  packages: { type: 'array', items: { type: 'string' } },
}

export const name = 'container-plugin'
export const inject = ['tools', 'workspaceRegistry']
export interface PluginConfig { controlSocket?: string; defaultImage?: string; projectsRoot?: string }
export function apply(ctx: any, config: PluginConfig = {}): void {
  const resolver = new WorkspaceResolver({ controlSocket: config.controlSocket ?? process.env.DSH_ORCH_CONTROL_SOCKET ?? process.env.DSH_CONTROL_SOCKET ?? '/run/dsh-sockets/control.sock', defaultImage: config.defaultImage ?? process.env.DSH_DEFAULT_IMAGE ?? 'arch-base', projectsRoot: config.projectsRoot ?? '/mnt/project' }, ctx.workspaceRegistry)
  ctx.provide('workspaceResolver', resolver)
  ctx.provide('subprocess', createSubprocessProvider(resolver))
  ctx.provide('fs', createFilesystemProvider(resolver))
  registerTools(ctx, resolver)
}

function createSubprocessProvider(resolver: WorkspaceResolver): object {
  return { spawn: (spec: any) => {
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || typeof spec.argv[0] !== 'string' || spec.argv[0] === '') throw new Error('argv must contain a program')
  const state = { pid: -1, stdin: undefined as any, stdout: spec.stdio?.stdout === 'pipe' ? new PassThrough() : undefined, stderr: spec.stdio?.stderr === 'pipe' ? new PassThrough() : undefined }
  const done = resolver.resolve(spec.cwd).then(binding => new Promise<any>((resolveDone, reject) => {
    const stream = (binding.agent as any).exec(metadata(binding.token)); stream.on('data', (output: any) => { if (output.stdoutChunk && state.stdout) state.stdout.write(output.stdoutChunk); if (output.stderrChunk && state.stderr) state.stderr.write(output.stderrChunk); if (output.exit) { state.stdout?.end(); state.stderr?.end(); resolveDone({ exitCode: output.exit.exitCode, signal: output.exit.signaled ? output.exit.signal : null }) } }); stream.on('error', reject); stream.write({ start: { argv: spec.argv, cwd: spec.cwd, env: spec.env ?? {}, runInBackground: false } }); if (spec.stdio?.stdin !== 'pipe') stream.end(); else state.stdin = new PassThrough({ final: () => { stream.end() } }); }))
  return { ...state, collected: {}, done, terminate: () => undefined, waitForExit: async () => { await done; return true } }
  } }
}
function createFilesystemProvider(resolver: WorkspaceResolver): object {
  return {
    resolve: async (path: string, opts?: any) => {
      if (!path.startsWith('/') || path.split('/').includes('..')) throw new Error('path must be an absolute safe workspace path')
      return { targetKey: path, displayPath: path, binding: await resolver.resolve(opts?.cwd) }
    },
    processPath: (target: any) => target.targetKey,
    fileUrl: (target: any) => `file://${target.targetKey}`,
    contains: (parent: any, child: any) => child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`),
    readText: async (target: any) => { const chunks: Buffer[] = []; await new Promise<void>((resolveDone, reject) => { const call = (target.binding.agent as any).readFile({ path: target.targetKey }, metadata(target.binding.token)); call.on('data', (chunk: any) => chunks.push(Buffer.from(chunk.data))); call.on('error', reject); call.on('end', resolveDone) }); return Buffer.concat(chunks).toString('utf8') },
    writeText: async (target: any, content: string) => { const call = (target.binding.agent as any).writeFile(metadata(target.binding.token)); call.write({ start: { path: target.targetKey, create: true, truncate: true } }); call.write({ dataChunk: Buffer.from(content) }); return new Promise((resolveDone, reject) => call.end((error: Error | null, result: unknown) => error ? reject(error) : resolveDone(result))) },
    stat: async (target: any) => new Promise((resolveDone, reject) => (target.binding.agent as any).stat({ path: target.targetKey }, metadata(target.binding.token), (error: Error | null, result: unknown) => error ? reject(error) : resolveDone(result))),
    listDir: async (target: any) => unaryAgent(target, 'readDir', { path: target.targetKey }),
    mkdir: async (target: any, parents = true) => unaryAgent(target, 'mkdir', { path: target.targetKey, parents }),
    remove: async (target: any, recursive = false) => unaryAgent(target, 'delete', { path: target.targetKey, recursive }),
  }
}
function defineLifecycleTool(ctx: any, resolver: WorkspaceResolver, name: string, description: string, method: string, parameters: object, approval = false): void {
  ctx.tools.register(defineTool({ name, description, parameters, ...(approval ? { approval: true } : {}), output: toolOutput, execute: async (input: any) => JSON.stringify(await unaryControl(resolver, method, input)) }))
}
function registerTools(ctx: any, resolver: WorkspaceResolver): void {
  defineLifecycleTool(ctx, resolver, 'recreate_workspace', 'Recreate the current workspace', 'recreateWorkspace', workspaceParameters)
  defineLifecycleTool(ctx, resolver, 'rebuild_image', 'Rebuild a workspace image', 'rebuildImage', imageParameters)
  ctx.tools.register(defineTool({ name: 'install_packages', description: 'Install ephemeral workspace packages', parameters: packageParameters, output: toolOutput, execute: async (input: any, exec: any) => { const cwd = exec?.agent?.session?.header?.cwd; const binding = cwd === undefined ? await resolver.resolveSlug(String(input.workspace_slug ?? '')) : await resolver.resolve(cwd); return JSON.stringify(await unaryAgent({ binding }, 'installPackages', input)) } }))
  defineLifecycleTool(ctx, resolver, 'share_workspace', 'Request human approval before widening workspace access', 'recreateWorkspace', workspaceParameters, true)
}
async function unaryControl(resolver: WorkspaceResolver, method: string, input: unknown): Promise<unknown> { return resolver.control(method, input) }
async function unaryAgent(target: any, method: string, request: unknown): Promise<unknown> { return new Promise((resolveDone, reject) => (target.binding.agent as any)[method](request, metadata(target.binding.token), (error: Error | null, result: unknown) => error ? reject(error) : resolveDone(result))) }
