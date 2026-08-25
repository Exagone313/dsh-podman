GO ?= go
GO_BUILD_TAGS = containers_image_openpgp exclude_graphdriver_btrfs exclude_graphdriver_devicemapper
GO_BUILD_FLAGS = -tags "$(GO_BUILD_TAGS)"
GOOS ?= linux
GOARCH ?= amd64
BIN_DIR ?= bin

GO_SOURCES := $(shell find cmd internal -type f -name '*.go' -print)
JS_SOURCES := $(shell find src -type f -name '*.ts' -print)
NODE_MODULES_TSC := node_modules/.bin/tsc

.PHONY: all build build-go npm-ci npm-build npm-test npm-prune clean

all: build

build: build-go npm-build

build-go: $(BIN_DIR)/dsh-workspace-agent $(BIN_DIR)/dsh-orchestrator


$(BIN_DIR)/dsh-workspace-agent: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) -o $(BIN_DIR)/dsh-workspace-agent ./cmd/dsh-workspace-agent

$(BIN_DIR)/dsh-orchestrator: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) -o $(BIN_DIR)/dsh-orchestrator ./cmd/dsh-orchestrator

npm-ci:
	npm ci

dist/index.js: $(JS_SOURCES) package.json package-lock.json tsconfig.json $(NODE_MODULES_TSC)
	npm run build

$(NODE_MODULES_TSC): package.json package-lock.json
	npm ci

npm-build: dist/index.js

npm-test:
	npm test

npm-prune:
	npm prune --omit=dev

clean:
	rm -rf $(BIN_DIR) dist node_modules
