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
IMAGE_PREFIX ?= localhost/dsh-podman-
IMAGE_TAG ?= latest
GIT_DESCRIBE := $(shell git describe --tags 2>/dev/null)
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null)
VERSION := $(if $(GIT_DESCRIBE),$(GIT_DESCRIBE),dev)
COMMIT := $(GIT_COMMIT)
GO_LDFLAGS = -ldflags "-X github.com/Exagone313/dsh-podman/internal/version.Version=$(VERSION) -X github.com/Exagone313/dsh-podman/internal/version.Commit=$(COMMIT)"

GO_SOURCES := $(shell find cmd internal -type f -name '*.go' -print)
JS_SOURCES := $(shell find src -type f \( -name '*.ts' -o -name '*.tsx' \) -print)
PROTO_SOURCES := $(shell find proto -type f -name '*.proto' -print)
NODE_MODULES_TSC := node_modules/.bin/tsc

.PHONY: all build build-go vet test test-go image image-orchestrator image-guestagent image-dsh download-licenses pnpm-install pnpm-build pnpm-test pnpm-prune clean

all: build

build: build-go pnpm-build

vet:
	$(GO) vet $(GO_BUILD_FLAGS) ./...

test: test-go pnpm-test

test-go:
	$(GO) test $(GO_BUILD_FLAGS) ./...

build-go: $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-orchestrator

image: image-orchestrator image-guestagent image-dsh

image-orchestrator: $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-orchestrator LICENSE.pkg
	$(CONTAINER) build --build-arg TARGETOS=$(GOOS) --build-arg TARGETARCH=$(GOARCH) -f Containerfile.orchestrator -t $(IMAGE_PREFIX)orchestrator:$(IMAGE_TAG) .

image-guestagent: $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent LICENSE.pkg
	$(CONTAINER) build --build-arg TARGETOS=$(GOOS) --build-arg TARGETARCH=$(GOARCH) -f Containerfile.guestagent -t $(IMAGE_PREFIX)guest-agent:$(IMAGE_TAG) .

image-dsh:
	$(CONTAINER) build -f Containerfile.dsh -t $(IMAGE_PREFIX)dsh:$(IMAGE_TAG) .

# LICENSE.pkg combines the project license with the licenses of every
# third-party Go module; it is generated, gitignored, and baked into the
# orchestrator and guest-agent images.
LICENSE.pkg: scripts/download-licenses.bash go.mod go.sum
	bash scripts/download-licenses.bash

download-licenses: LICENSE.pkg

$(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)/$(GOOS)-$(GOARCH)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) $(GO_LDFLAGS) -o $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent ./cmd/dsh-podman-guest-agent

$(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-orchestrator: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)/$(GOOS)-$(GOARCH)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) $(GO_LDFLAGS) -o $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-orchestrator ./cmd/dsh-podman-orchestrator

pnpm-install:
	pnpm install --frozen-lockfile

dist/index.js: $(JS_SOURCES) $(PROTO_SOURCES) package.json pnpm-lock.yaml tsconfig.json tsconfig.client.json $(NODE_MODULES_TSC)
	pnpm run build

$(NODE_MODULES_TSC): package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile

pnpm-build: dist/index.js

pnpm-test: pnpm-build
	pnpm test

pnpm-prune:
	pnpm prune --prod

clean:
	rm -rf $(BIN_DIR) dist node_modules LICENSE.pkg
