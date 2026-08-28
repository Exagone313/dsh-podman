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
JS_SOURCES := $(shell find src -type f \( -name '*.ts' -o -name '*.tsx' \) -print)
PROTO_SOURCES := $(shell find proto -type f -name '*.proto' -print)
NODE_MODULES_TSC := node_modules/.bin/tsc

.PHONY: all build build-go image image-guestagent pnpm-install pnpm-build pnpm-test pnpm-prune clean

all: build

build: build-go pnpm-build

build-go: $(BIN_DIR)/dsh-podman-guest-agent $(BIN_DIR)/dsh-podman-orchestrator

image: build-go
	$(CONTAINER) build -f Containerfile.orchestrator -t localhost/dsh-podman-orchestrator:latest .

image-guestagent: build-go
	$(CONTAINER) build -f Containerfile.guestagent -t localhost/dsh-podman-guest-agent:latest .

$(BIN_DIR)/dsh-podman-guest-agent: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) -o $(BIN_DIR)/dsh-podman-guest-agent ./cmd/dsh-podman-guest-agent

$(BIN_DIR)/dsh-podman-orchestrator: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) -o $(BIN_DIR)/dsh-podman-orchestrator ./cmd/dsh-podman-orchestrator

pnpm-install:
	pnpm install --frozen-lockfile

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
