<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 开发

本页面向从本仓库构建插件的**贡献者**。

## 仓库结构

- `src/` — Cordis 插件（宿主端 + 浏览器客户端）。
- `cmd/dsh-podman-orchestrator/` 和 `cmd/dsh-podman-guest-agent/` — 两个 Go
  二进制文件。
- `internal/` — orchestrator、guest agent 和 protobuf 绑定的 Go 实现。
- `proto/` — gRPC 定义。
- `.github/workflows/` — CI 和发布自动化。

## 构建

前置要求：Go 1.27、Node ≥ 22、pnpm 10，以及（浏览器端所需的）发布在 npm 上的
`@deepseek-ai/dsh-client-*` 包。

```sh
pnpm install
pnpm run build       # tsc host + tsc client -> dist/, copies proto/ -> dist/grpc/proto/
```

Go 构建标签会跳过 btrfs 和 devicemapper 存储驱动，它们需要宿主机的 C
头文件；`make` 会自动应用相同的标签。

`Makefile` 封装了常见的工作流：

```sh
make build-go       # build both Go binaries into bin/<os>-<arch>/
make build          # build-go + pnpm-build
make vet            # go vet with the build tags
make test-go        # go test with the build tags
make test           # test-go + pnpm test (JS tests, which run against dist/)
make download-licenses  # generate LICENSE.pkg from the project and third-party Go licenses
make image          # build the orchestrator and guest-agent container images
```

`make image` 依赖 `LICENSE.pkg`：`download-licenses` 目标会运行
`scripts/download-licenses` 中的 Go 收集器，它调用 `go-licenses save` 并将项目的
MIT 许可证以及所有第三方 Go 许可证和 Apache `NOTICE` 汇总到 `LICENSE.pkg`
中。该文件被 gitignore （从不提交），并被烘焙进 orchestrator 和 guest-agent
镜像，位于 `/usr/share/licenses/dsh-podman/LICENSE`；由于工作区容器会挂载
guest-agent 镜像，因此它也会随之进入每个工作区容器。

`pnpm test` 运行 `node --test dist/*.test.js`，因此它要求先运行 `pnpm build`
（`test` 目标会处理这一点）。

## Protobuf

`.proto` 源文件位于 `proto/`；生成的 Go 绑定位于
`internal/genproto/`，会被提交。修改 `.proto` 后，需要使用单独安装的
Buf（`buf generate`）重新生成（没有对应的 `make` 目标）。请将 `.proto`
改动与重新生成的 Go 绑定一起提交。

`buf.gen.yaml` 还会通过 `buf.build/bufbuild/es` 将 TypeScript 绑定生成到
`src/grpc/`，但该输出未被使用：JS 端在运行时通过 `@grpc/proto-loader` 加载原始
`.proto` 文件（构建时复制到 `dist/grpc/proto/`）。不要提交该 TypeScript
输出。也可以使用 `buf lint` 和 `buf breaking` 校验 schema。

## 安装开发构建

### 构建

```bash
make  # builds plugin and go binaries
make image  # build images
```

### 重建容器

```bash
systemctl --user restart dsh dsh-podman-orchestrator
```

### 更新插件

```bash
npm pack
v="$(jq -r .version package.json)"
podman cp ./exagone313-dsh-podman-"${v}".tgz dsh:/tmp/
podman exec -it dsh dsh plugin --profile web remove @exagone313/dsh-podman  # necessary, to force reinstall if the same version
podman exec -it dsh dsh plugin --profile web add /tmp/exagone313-dsh-podman-"${v}".tgz --allow-build=protobufjs
systemctl --user restart dsh
```

## 持续集成

CI（`.github/workflows/ci.yml`）在每次分支推送和拉取请求时运行：

- **actions-lint** — zizmor 扫描工作流是否存在不安全实践。
- **go** — 构建、vet、测试和 govulncheck（Go 漏洞）。未修复的
  发现不会导致任务失败；可修复的会导致失败。
- **js** — 安装、类型检查、构建、测试和 `pnpm audit`。
- **images** — 构建 orchestrator 和 guest-agent 镜像（仅在测试任务通过后运行）。
- **trivy** — 文件系统漏洞扫描（未修复的被忽略）和容器 错误配置扫描（DS-0002
  通过 `.trivyignore.yaml` 排除）。

所有第三方 actions 都锁定到完整的提交 SHA，并由 zizmor 检查。

## 发布

发布由推送**纯 Semver 标签**（`x.y.z`，不带 `v`； 像 `1.0.0-rc.1`
这样的预发布同样有效）触发。发布工作流 （`.github/workflows/release.yml`）：

1. 运行测试，然后为 `linux/amd64` 和 `linux/arm64` 构建两个二进制文件。
2. 将 **orchestrator** 和 **guest-agent** 镜像推送到 GHCR
   （`ghcr.io/exagone313/dsh-podman/{orchestrator,guest-agent}`），并打上
   版本号以及稳定版的 `latest` 标签（预发布永远不会获得 `latest`）。
3. 将插件发布到 **npm**（`@exagone313/dsh-podman`），附带来源证明； 预发布在
   `next` dist-tag 下发布。
4. 创建带有自动生成说明的 **GitHub release**，并附上 二进制文件和 npm tarball。

使用以下命令推送标签：

```sh
git tag 0.1.1
git push origin 0.1.1
```

npm 步骤要求仓库配置 `NPM_TOKEN` 密钥。
