# dsh-container-plugin

This repository contains the `dsh-orchestrator`, `dsh-workspace-agent`, and
`@exagone313/dsh-container-workspace` Cordis plugin.

## Build

```sh
go test ./...
npm ci
npm run build
```

Protobuf bindings are generated with Buf using `buf.build/bufbuild/es` for
TypeScript and the official Go protobuf and gRPC plugins. The control socket
and agent socket are Unix sockets configured with `DSH_CONTROL_SOCKET` and
`DSH_AGENT_SOCKET`; workspace configuration uses `DSH_AGENT_TOKEN` and
`DSH_WORKSPACE_ROOT`.

The plugin auto-creates a missing workspace using `DSH_DEFAULT_IMAGE` and a
single read-write project mount. It never falls back to host execution.
