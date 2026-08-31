<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# dsh-podman

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@exagone313/dsh-podman)](https://www.npmjs.com/package/@exagone313/dsh-podman)
[![GitHub release](https://img.shields.io/github/v/release/Exagone313/dsh-podman)](https://github.com/Exagone313/dsh-podman/releases)
[![orchestrator](https://img.shields.io/badge/orchestrator-GHCR-blue)](https://github.com/Exagone313/dsh-podman/pkgs/container/dsh-podman%2Forchestrator)
[![guest-agent](https://img.shields.io/badge/guest--agent-GHCR-blue)](https://github.com/Exagone313/dsh-podman/pkgs/container/dsh-podman%2Fguest-agent)

Podman-backed execution for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`). The `@exagone313/dsh-podman` plugin routes all shell execution and
file access through disposable, per-project Podman containers instead of the
dsh host — it never falls back to host execution and never touches the host
filesystem.

## Documentation

- **[Installation](docs/installation.md)** — install the plugin from npm and run
  the orchestrator with a Quadlet systemd unit.
- **[Configuration](docs/configuration.md)** — environment variables, UI
  settings, and image prefixes.
- **[Usage](docs/usage.md)** — the model-facing tools, approvals, the settings
  card, and the image model.
- **[Architecture](docs/architecture.md)** — what runs where and how the pieces
  fit together.
- **[Development](docs/development.md)** — building and testing locally, CI,
  and releasing (for contributors).

## License

MIT