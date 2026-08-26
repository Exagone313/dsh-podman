# dsh-container-plugin

This repository contains the `dsh-orchestrator`, `dsh-workspace-agent`, and
`@exagone313/dsh-container-plugin` Cordis plugin.

## Build

```sh
go test ./...
npm ci
npm run build
```

Protobuf bindings are generated with Buf using `buf.build/bufbuild/es` for
TypeScript and the official Go protobuf and gRPC plugins. The control socket
the control socket is created below `DSH_ORCH_SOCKETS_ROOT`; agent socket and
token variables are internal to workspace containers.

The orchestrator deployment variables are `DSH_ORCH_STATE`,
`DSH_ORCH_AGENT_BIN`, `DSH_ORCH_SOCKETS_ROOT`, `DSH_ORCH_PROJECTS_ROOT`,
`DSH_ORCH_PODMAN_SOCKET`, `DSH_ORCH_HOST_PROJECTS_ROOT`,
`DSH_ORCH_HOST_SOCKETS_ROOT`, and `DSH_ORCH_HOST_AGENT_BIN`. The optional
`DSH_ORCH_DEFAULT_IMAGE` selects the default image ID and otherwise defaults
to `arch-base`.

`DSH_ORCH_PROJECTS_ROOT` is the shared project prefix inside all containers;
`DSH_ORCH_HOST_PROJECTS_ROOT` is the corresponding real host prefix used as
the source of bind mounts.

The plugin auto-creates a missing workspace using its configured default image and a
single read-write project mount. It never falls back to host execution.
