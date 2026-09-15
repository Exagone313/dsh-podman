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

English | [中文](README.zh.md)

[Podman](https://podman.io/)-backed execution for
[DeepSeek Harness](https://deepseek.com/harness) (`dsh`).

dsh-podman routes all shell execution and file access through disposable and
per-project Podman containers.

## Documentation

- **[Install DeepSeek Harness & dsh-podman with rootless Podman](docs/install-dsh-and-dsh-podman.md)**
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Usage](docs/usage.md)
- [Development](docs/development.md)

## AI-usage disclosure

This repository was written in major parts using AI models:

- early commits using OpenAI GPT-5.6 Luna
- DeepSeek V4 Flash
- source code weakness fixes by Anthropic Claude Opus 5

## License

[MIT](./LICENSE)
