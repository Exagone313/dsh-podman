import { WorkspaceResolver } from './workspace-binding.js'
import { metadata } from './workspace-binding.js'
import { PassThrough } from 'node:stream'

export interface PluginConfig { controlSocket?: string; defaultImage?: string }
export function apply(ctx: any, config: PluginConfig = {}): void {
  const resolver = new WorkspaceResolver({ controlSocket: config.controlSocket ?? process.env.DSH_CONTROL_SOCKET ?? '/run/dsh-sockets/control.sock', defaultImage: config.defaultImage ?? process.env.DSH_DEFAULT_IMAGE ?? 'arch-base' })
  ctx.workspaceResolver = resolver
  ctx.subprocess = createSubprocessProvider(resolver)
  ctx.fs = createFilesystemProvider(resolver)
  if (ctx.tools?.register !== undefined) registerTools(ctx, resolver)
}

function createSubprocessProvider(resolver: WorkspaceResolver): object {
  return { spawn: (spec: any) => {
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || typeof spec.argv[0] !== 'string' || spec.argv[0] === '') throw new Error('argv must contain a program')
  const state = { pid: -1, stdin: undefined as any, stdout: spec.stdio?.stdout === 'pipe' ? new PassThrough() : undefined, stderr: spec.stdio?.stderr === 'pipe' ? new PassThrough() : undefined }
  const done = resolver.resolve(spec.session ?? spec).then(binding => new Promise<any>((resolveDone, reject) => {
    const stream = (binding.agent as any).exec(metadata(binding.token)); stream.on('data', (output: any) => { if (output.stdoutChunk && state.stdout) state.stdout.write(output.stdoutChunk); if (output.stderrChunk && state.stderr) state.stderr.write(output.stderrChunk); if (output.exit) { state.stdout?.end(); state.stderr?.end(); resolveDone({ exitCode: output.exit.exitCode, signal: output.exit.signaled ? output.exit.signal : null }) } }); stream.on('error', reject); stream.write({ start: { argv: spec.argv, cwd: spec.cwd, env: spec.env ?? {}, runInBackground: false } }); if (spec.stdio?.stdin !== 'pipe') stream.end(); else state.stdin = new PassThrough({ final: () => { stream.end() } }); }))
  return { ...state, collected: {}, done, terminate: () => undefined, waitForExit: async () => { await done; return true } }
  } }
}
function createFilesystemProvider(resolver: WorkspaceResolver): object {
  return {
    resolve: async (path: string, opts?: any) => {
      if (!path.startsWith('/') || path.split('/').includes('..')) throw new Error('path must be an absolute safe workspace path')
      return { targetKey: path, displayPath: path, binding: await resolver.resolve(opts?.session) }
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
function registerTools(ctx: any, resolver: WorkspaceResolver): void { ctx.tools.register({ name: 'recreate_workspace', description: 'Recreate the current workspace', execute: async (input: any) => unaryControl(resolver, 'recreateWorkspace', input) }); ctx.tools.register({ name: 'rebuild_image', description: 'Rebuild a workspace image', execute: async (input: any) => unaryControl(resolver, 'rebuildImage', input) }); ctx.tools.register({ name: 'install_packages', description: 'Install ephemeral workspace packages', execute: async (input: any) => { const binding = await resolver.resolve(input); return unaryAgent({ binding }, 'installPackages', input) } }); ctx.tools.register({ name: 'share_workspace', description: 'Request human approval before widening workspace access', approval: true, execute: async (input: any) => unaryControl(resolver, 'recreateWorkspace', input) }) }
async function unaryControl(resolver: WorkspaceResolver, method: string, input: unknown): Promise<unknown> { return resolver.control(method, input) }
async function unaryAgent(target: any, method: string, request: unknown): Promise<unknown> { return new Promise((resolveDone, reject) => (target.binding.agent as any)[method](request, metadata(target.binding.token), (error: Error | null, result: unknown) => error ? reject(error) : resolveDone(result))) }
export default apply
