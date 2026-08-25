import { WorkspaceResolver } from './workspace-binding.js'

export interface PluginConfig { controlSocket?: string; defaultImage?: string }
export function apply(ctx: any, config: PluginConfig = {}): void {
  const resolver = new WorkspaceResolver({ controlSocket: config.controlSocket ?? process.env.DSH_CONTROL_SOCKET ?? '/run/dsh-sockets/control.sock', defaultImage: config.defaultImage ?? process.env.DSH_DEFAULT_IMAGE ?? 'arch-base' })
  ctx.workspaceResolver = resolver
  ctx.subprocess = createSubprocessProvider(resolver)
  ctx.fs = createFilesystemProvider(resolver)
  if (ctx.tools?.register !== undefined) registerTools(ctx, resolver)
}

function createSubprocessProvider(resolver: WorkspaceResolver): object { return { spawn: (spec: any) => { const promise = resolver.resolve(spec.session ?? spec); return { pid: -1, stdin: undefined, stdout: undefined, stderr: undefined, collected: {}, done: promise.then(() => ({ exitCode: null, signal: null })), terminate: () => undefined, waitForExit: async () => { await promise; return true } } } } }
function createFilesystemProvider(resolver: WorkspaceResolver): object { return { resolve: async (path: string, opts?: any) => ({ targetKey: path, displayPath: path, binding: await resolver.resolve(opts?.session) }), processPath: (target: any) => target.targetKey, fileUrl: (target: any) => `file://${target.targetKey}`, contains: (parent: any, child: any) => child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`) } }
function registerTools(ctx: any, resolver: WorkspaceResolver): void { ctx.tools.register({ name: 'recreate_workspace', description: 'Recreate the current workspace', execute: async (input: any) => unaryControl(resolver, 'recreateWorkspace', input) }); ctx.tools.register({ name: 'rebuild_image', description: 'Rebuild a workspace image', execute: async (input: any) => unaryControl(resolver, 'rebuildImage', input) }); ctx.tools.register({ name: 'share_workspace', description: 'Request human approval before widening workspace access', approval: true, execute: async (input: any) => unaryControl(resolver, 'recreateWorkspace', input) }) }
async function unaryControl(resolver: WorkspaceResolver, method: string, input: unknown): Promise<unknown> { const binding = await resolver.resolve(input); return (binding as any).agent[method](input) }
export default apply
