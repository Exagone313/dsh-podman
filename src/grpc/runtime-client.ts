import grpc from "@grpc/grpc-js";
import loader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "proto");
const definitions = new Map<string, grpc.ServiceClientConstructor>();

function unixTarget(socket: string): string {
  return socket.startsWith("unix:") ? socket : `unix:${socket}`;
}

function client(service: string, proto: string, socket: string): grpc.Client {
  const key = `${service}:${socket}`;
  let Constructor = definitions.get(key);
  if (Constructor === undefined) {
    const packageDefinition = loader.loadSync(resolve(root, proto), {
      longs: String,
      enums: String,
      defaults: true,
    });
    const loaded = grpc.loadPackageDefinition(
      packageDefinition,
    ) as unknown as Record<string, unknown>;
    const namespace = service.startsWith("dshctl")
      ? (loaded.dshctl as Record<string, unknown>)
      : (loaded.dshguest as Record<string, unknown>);
    const version = namespace.v1 as Record<string, unknown>;
    Constructor = version[
      service.split(".").at(-1)!
    ] as grpc.ServiceClientConstructor;
    definitions.set(key, Constructor);
  }
  return new Constructor(unixTarget(socket), grpc.credentials.createInsecure());
}

export function controlClient(socket: string): grpc.Client {
  return client(
    "dshctl.v1.OrchestratorControl",
    "dshctl/v1/control.proto",
    socket,
  );
}
export function guestClient(socket: string): grpc.Client {
  return client(
    "dshguest.v1.WorkspaceGuestAgent",
    "dshguest/v1/agent.proto",
    socket,
  );
}
export function unary<T>(
  client: grpc.Client,
  method: string,
  request: unknown,
  metadata?: grpc.Metadata,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    (client as unknown as Record<string, Function>)[method](
      request,
      metadata ?? new grpc.Metadata(),
      (error: Error | null, value: T) =>
        error ? reject(error) : resolvePromise(value),
    );
  });
}
export { grpc };
