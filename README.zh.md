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

[English](README.md) | 中文

基于 [Podman](https://podman.io/) 的
[DeepSeek Harness](https://deepseek.com/harness)（`dsh`）执行后端。

dsh-podman 将所有的 shell 执行与文件访问都路由到一次性、按项目隔离的 Podman
容器中。

## 文档

- **[使用 rootless Podman 安装 DeepSeek Harness 与 dsh-podman](docs/install-dsh-and-dsh-podman.zh.md)**
- [架构](docs/architecture.zh.md)
- [配置](docs/configuration.zh.md)
- [使用](docs/usage.zh.md)
- [开发](docs/development.zh.md)

## AI 使用声明

本仓库的大部分代码由 AI 模型编写：

- 早期提交使用 OpenAI GPT-5.6 Luna
- DeepSeek V4 Flash
- 源代码弱点修复由 Anthropic Claude Opus 5 完成

## 许可证

[MIT](./LICENSE)
