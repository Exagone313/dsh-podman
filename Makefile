# SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
#
# SPDX-License-Identifier: MIT

GO ?= go
GO_BUILD_TAGS = containers_image_openpgp exclude_graphdriver_btrfs exclude_graphdriver_devicemapper
GO_BUILD_FLAGS = -tags "$(GO_BUILD_TAGS)"
GOOS ?= linux
GOARCH ?= amd64
BIN_DIR ?= bin
CONTAINER ?= podman

GO_SOURCES := $(shell find cmd internal -type f -name '*.go' -print)
JS_SOURCES := $(shell find src -type f ( -name '*.ts' -o -name '*.tsx' ) -print)
PROTO_SOURCES := $(shell find proto -type f -name '*.proto' -print)
NODE_MODULES_TSC := node_modules/.bin/tsc

.PHONY: all build build-go image pnpm-install pnpm-build pnpm-test pnpm-prune link-dh clean

all: build

build: build-go pnpm-build

build-go: $(BIN_DIR)/dsh-podman-guest-agent $(BIN_DIR)/dsh-podman-orchestrator

image: build-go
	$(CONTAINER) build -f Containerfile.orchestrator -t localhost/dsh-podman-orchestrator:latest .

$(BIN_DIR)/dsh-podman-guest-agent: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) -o $(BIN_DIR)/dsh-podman-guest-agent ./cmd/dsh-podman-guest-agent

$(BIN_DIR)/dsh-podman-orchestrator: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) -o $(BIN_DIR)/dsh-podman-orchestrator ./cmd/dsh-podman-orchestrator

pnpm-install:
	pnpm install --frozen-lockfile

# Link the DeepSeek Harness workspace packages this plugin depends on into
# node_modules so local tsc (host and client halves) can resolve them. Point
# DSH_ROOT at your deepseek-harness checkout.
link-dh:
	@if [ -z "$(DSH_ROOT)" ]; then echo "usage: make link-dh DSH_ROOT=/path/to/deepseek-harness"; exit 1; fi
	@mkdir -p node_modules/@deepseek-ai node_modules/@types
	@for p in schemastery dsh-settings dsh-client-runtime dsh-client-ui-slots dsh-client-ui-settings dsh-client-locale dsh-client-connection; do \
		ln -sfn "$(DSH_ROOT)/node_modules/.pnpm/node_modules/@deepseek-ai/$$p" "node_modules/@deepseek-ai/$$p"; \
	done
	@ln -sfn "$(DSH_ROOT)/node_modules/.pnpm/react@18.3.1/node_modules/react" node_modules/react
	@ln -sfn "$(DSH_ROOT)/node_modules/.pnpm/@types+react@18.3.31/node_modules/@types/react" node_modules/@types/react
	@echo "linked DeepSeek Harness packages from $(DSH_ROOT)"

dist/index.js: $(JS_SOURCES) $(PROTO_SOURCES) package.json pnpm-lock.yaml tsconfig.json tsconfig.client.json $(NODE_MODULES_TSC)
	pnpm run build

$(NODE_MODULES_TSC): package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile

pnpm-build: dist/index.js

pnpm-test:
	pnpm test

pnpm-prune:
	pnpm prune --prod

clean:
	rm -rf $(BIN_DIR) dist node_modules
