GO ?= go
GO_BUILD_TAGS = containers_image_openpgp exclude_graphdriver_btrfs exclude_graphdriver_devicemapper
GO_BUILD_FLAGS = -tags "$(GO_BUILD_TAGS)"
GOOS ?= linux
GOARCH ?= amd64
BIN_DIR ?= bin

.PHONY: all build build-go build-agent build-orchestrator npm-ci npm-build npm-test npm-prune clean

all: build

build: build-go npm-build

build-go: build-agent build-orchestrator

build-agent:
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) -o $(BIN_DIR)/dsh-workspace-agent ./cmd/dsh-workspace-agent

build-orchestrator:
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) -o $(BIN_DIR)/dsh-orchestrator ./cmd/dsh-orchestrator

npm-ci:
	npm ci

npm-build: npm-ci
	npm run build

npm-test:
	npm test

npm-prune:
	npm prune --omit=dev

clean:
	rm -rf $(BIN_DIR) dist node_modules
