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

前置要求：Go 1.27、Node ≥ 22、pnpm 12、Deno ≥ 2.9（用于格式化），以及（浏览器端所需的）发布在
npm 上的 `@deepseek-ai/dsh-client-*` 包。

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
make vet            # gofmt -s check + go vet with the build tags
make test-go        # go test with the build tags
make test           # test-go + pnpm test (JS tests, which run against dist/)
make fmt            # gofmt -s + deno fmt (TypeScript and Markdown)
make fmt-check      # verify the formatting without rewriting anything
make download-licenses  # generate LICENSE.pkg from the project and third-party Go licenses
make image          # build the orchestrator, guest-agent and dsh container images
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
Buf（`buf generate`）重新生成（没有对应的 `make` 目标）——请用
`go install github.com/bufbuild/buf/cmd/buf@v1.73.0` 固定版本。请将 `.proto`
改动与重新生成的 Go 绑定一起提交。

JS 端在运行时通过 `@grpc/proto-loader` 加载原始 `.proto` 文件（构建时复制到
`dist/grpc/proto/`）；不生成 TypeScript 绑定。也可以使用 `buf lint` 和
`buf breaking` 校验 schema。

## 命名

`.proto` 字段名为 `lower_snake_case`（Buf 的 `BASIC` lint 会强制检查），JS
端通过 proto-loader 的 camelCase 投影读取，因此 `secret_env` 变为
`secretEnv`、`image_id` 变为 `imageId`。切勿在 TypeScript 中使用下划线形式的
proto 字段名：proto-loader 会忽略未知属性，该值会被静默丢弃。

工具参数使用 camelCase，只有刻意与 harness
内置工具保持一致的名字除外（`file_path`、`old_string`、`new_string`、`replace_all`）。设置项使用
camelCase；持久化的 TOML 状态使用下划线标签。

## 安装开发构建

### 构建

```bash
make  # builds plugin and go binaries
make image  # build images
```

### 运行本地镜像（Quadlet）

随附的单元会拉取发布镜像。把它们指向 `make image` 构建的镜像，就能把本地构建当作正式服务来运行；把原来的行注释掉，切回时只需改一行。

在 `~/.config/containers/systemd/dsh.container` 中：

```ini
#Image=ghcr.io/exagone313/dsh-podman/dsh:1
Image=localhost/dsh-podman-dsh:latest
Environment=DSH_PODMAN_PLUGIN_SOURCE=%h/project/dsh-podman
```

该单元已经把 `%h/project` 以只读方式挂载，因此检出在 `~/project` 下的仓库无需额外的 `Volume=`。`npm pack` 会把入口脚本要安装的归档放在 `package.json` 旁边（见[安装本地插件构建](#安装本地插件构建)）。

在 `~/.config/containers/systemd/dsh-podman-orchestrator.container` 中：

```ini
#Image=ghcr.io/exagone313/dsh-podman/orchestrator:1
Image=localhost/dsh-podman-orchestrator:latest
#Environment=DSH_PODMAN_GUEST_AGENT_IMAGE=ghcr.io/exagone313/dsh-podman/guest-agent
#Environment=DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG=true
Environment=DSH_PODMAN_GUEST_AGENT_IMAGE=localhost/dsh-podman-guest-agent:latest
```

发布引用带有版本标签，因此每个发布版本都有各自不同的镜像引用。本地构建则复用同一个
`:latest` 标签；orchestrator 因此无法察觉 guest agent 已被重建，详见[更新工作区容器](#更新工作区容器)。

编辑单元后重新加载 systemd：

```bash
systemctl --user daemon-reload
```

### 部署改动

```bash
make            # Go binaries + the plugin bundle
make image      # orchestrator, guest-agent and dsh images
npm pack        # the plugin archive the dsh entrypoint installs
systemctl --user restart dsh dsh-podman-orchestrator
```

dsh 镜像会在容器启动时安装插件，因此重启 dsh 才会重新安装刚打包的归档；重启 orchestrator
则会采用新的 orchestrator 与 guest-agent 镜像。

### 更新工作区容器

guest-agent 镜像会在容器创建时挂载进去，因此正在运行的容器仍使用它启动时的那份 agent。只有当容器的
guest-agent 镜像引用与当前配置不一致时，orchestrator 才会自行重建该容器——带版本标签的发布引用会如此，本地
`:latest` 标签则不会。重建 guest agent 之后，请自行重建容器：

- 在设置卡片中按容器操作：**Recreate**（沿用当前镜像）或 **Recreate with image**；
- 或使用 `container_recreate`，作用于命名容器或默认容器。

若要重建整个工作区，可在其行上使用 **Remove pod**（或 `RemoveWorkspace`）：pod
及其所有容器都会被移除，下次接入时会重新创建 pod 与默认容器。重启这两个服务绝不会触及工作区容器，上述两种操作也都不会删除卷、机密或项目数据。

仍在运行旧镜像中 guest agent 的容器会让 dsh 为其 guest 套接字记录
`rejected by server because of excess pings`。该消息无害（grpc-js 会退避并重连），重建该容器后即消失；若同样的消息出现在
`orchestrator.sock` 上，则说明 orchestrator 服务仍在运行上一个镜像。

### 安装本地插件构建

dsh 镜像会在容器启动时自行安装插件，因此本地开发构建通过将安装源指向 bind mount
的包来使用。上面的 Quadlet 配置就是下面第一种形式，仓库目录本身
（`%h/project/dsh-podman`）已经通过单元的只读 `%h/project` 挂载可见。先构建并打包插件：

```bash
pnpm build
npm pack          # 生成 exagone313-dsh-podman-<version>.tgz
```

然后在 dsh 容器单元中加入以下之一并重启：

```
# 仓库目录，其中必须包含已打包的归档
Volume=/path/to/repo:/mnt/dsh-podman:ro
Environment=DSH_PODMAN_PLUGIN_SOURCE=/mnt/dsh-podman
```

```
# 或者归档本身
Volume=/path/to/exagone313-dsh-podman-x.y.z.tgz:/mnt/dsh-podman.tgz:ro
Environment=DSH_PODMAN_PLUGIN_SOURCE=/mnt/dsh-podman.tgz
```

入口脚本会在每次启动时安装该包，且绝不会回退到注册表——找不到包即为错误。重新运行
`pnpm build && npm pack` 并重启 dsh 即可生效。

未设置 `DSH_PODMAN_PLUGIN_SOURCE` 时，入口脚本会精确安装
`@exagone313/dsh-podman@$DSH_PODMAN_PLUGIN_VERSION`（镜像构建时写入的版本），并相应升级或降级配置中的副本。

## 持续集成

CI 在每次**分支**推送和拉取请求时运行，分散在
`.github/workflows/ci-common.yml`（REUSE lint 与
zizmor）、`ci-code.yml`（Go、JS、镜像、Trivy）、`ci-docs.yml`（Deno fmt）和
`ci-dsh-image.yml` 中。推送**标签**时只运行 `release.yml`，它自身会重复构建、vet
和测试：

- **actions-lint** — zizmor 扫描工作流是否存在不安全实践。
- **reuse** — REUSE 许可证合规检查。
- **go** — 构建、`gofmt -s` 检查、vet、测试和 govulncheck（Go 漏洞）。未修复的
  发现不会导致任务失败；可修复的会导致失败。
- **js** — TypeScript 格式检查、安装、类型检查、构建、测试和 `pnpm audit`。
- **docs** — Markdown 格式检查（通过 `make fmt-check-md` 运行 `deno fmt`）。
- **images** — 构建 orchestrator 和 guest-agent
  镜像（仅在测试任务通过后运行）；**dsh image** 构建 `Containerfile.dsh`。
- **trivy** — 文件系统漏洞扫描（未修复的被忽略）和容器 错误配置扫描（DS-0002
  通过 `.trivyignore.yaml` 排除）。

所有第三方 actions 都锁定到完整的提交 SHA，并由 zizmor 检查。

## 发布

发布由推送**纯 Semver 标签**（`x.y.z`，不带 `v`； 像 `1.0.0-rc.1`
这样的预发布同样有效）触发。发布工作流 （`.github/workflows/release.yml`）：

1. 运行测试，然后为 `linux/amd64` 和 `linux/arm64` 构建两个二进制文件。
2. 将 **dsh**、**orchestrator** 和 **guest-agent** 镜像推送到 GHCR
   （`ghcr.io/exagone313/dsh-podman/{dsh,orchestrator,guest-agent}`）。每个发布都打上其版本标签；**稳定**发布——`1.0.0`
   及以上且不带预发布后缀——还会打上其主版本号（`1`）和 `latest`。`0.x`
   发布以及任何带连字符的标签都属于预发布：只打版本标签。
3. 将插件发布到 **npm**（`@exagone313/dsh-podman`），附带来源证明； 预发布在
   `next` dist-tag 下发布。
4. 创建带有自动生成说明的 **GitHub release**，并附上 二进制文件和 npm tarball。

标签必须与 `package.json`
中的版本一致——否则工作流会失败——因此请用版本脚本同时更新两者：

```sh
pnpm bump-version x.y.z            # 加上 --dry-run 则仅校验
git push origin master x.y.z
```

`scripts/bump-version.mjs` 会检查版本是否为递增的 Semver
正式版或预发布版，将其写入 `package.json`，提交
`chore: bump version to X`，并创建标签；它不会推送，且要求处于 `master`
分支且工作区干净。标签同时也是构建出的插件与二进制文件所报告的版本，因为
`scripts/generate-version.mjs` 从 `git describe --tags`
推导嵌入的版本。预发布版（`1.0.0-rc.1`）也用同样的方式递增。

也可以在 Actions 页面通过 `workflow_dispatch`
触发发布，或重新运行失败的发布，版本作为输入传入。已完成的步骤会被跳过（npm
会跳过已存在的版本，已有的 GitHub release 不会被改动），因此重试不会重复发布。

npm 步骤要求仓库配置 `NPM_TOKEN` 密钥。
