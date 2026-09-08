# ffweb — build, run and check from one place.
#
# `make` on its own prints the target list. Most targets are thin wrappers over
# cargo and npm; the ones worth knowing are `make dev` (hot-reloading frontend
# against the real server) and `make check` (everything CI would run).

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Overridable on the command line: `make run PORT=9000 ROOT=~/Videos`
PORT ?= 7788
HOST ?= 127.0.0.1
# Port the Vite dev server listens on for `make dev`.
UI_PORT ?= 5173
ROOT ?=
OUT  ?=
# Extra flags appended to the server invocation, e.g. `make run ARGS=--no-open`
ARGS ?=

WEB      := web
DIST     := assets/dist
NODE_MOD := $(WEB)/node_modules
BIN      := target/debug/ffweb
RELEASE  := target/release/ffweb

# Every frontend source file; the bundle is rebuilt when any of them changes.
UI_SOURCES := $(shell find $(WEB)/src -type f 2>/dev/null) \
              $(WEB)/index.html $(WEB)/package.json $(WEB)/vite.config.ts

SERVE_FLAGS := --port $(PORT) --host $(HOST)
ifneq ($(strip $(ROOT)),)
SERVE_FLAGS += --root $(ROOT)
endif
ifneq ($(strip $(OUT)),)
SERVE_FLAGS += --out $(OUT)
endif
SERVE_FLAGS += $(ARGS)

.PHONY: help
help: ## Show this help
	@echo "ffweb — a local web interface for ffmpeg"
	@echo
	@echo "Targets:"
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Variables:  PORT=$(PORT)  UI_PORT=$(UI_PORT)  HOST=$(HOST)  ROOT=$${ROOT:-<cwd>}  OUT=$${OUT:-./ffweb-out}"
	@echo "Example:    make run PORT=9000 ROOT=~/Videos ARGS=--no-open"

# ----------------------------------------------------------------- building

$(NODE_MOD): $(WEB)/package-lock.json
	@echo "==> installing frontend dependencies"
	npm --prefix $(WEB) ci --no-audit --no-fund
	@touch $(NODE_MOD)

.PHONY: setup
setup: $(NODE_MOD) ## Install frontend dependencies

$(DIST)/index.html: $(NODE_MOD) $(UI_SOURCES)
	@echo "==> building the frontend"
	npm --prefix $(WEB) run build

.PHONY: ui
ui: $(DIST)/index.html ## Build the frontend bundle

.PHONY: build
build: ui ## Build the debug binary
	cargo build

.PHONY: release
release: ui ## Build the optimised binary
	cargo build --release
	@echo "==> $(RELEASE) ($$(du -h $(RELEASE) | cut -f1))"

.PHONY: install
install: ui ## Install ffweb into ~/.cargo/bin
	cargo install --path . --locked

# ----------------------------------------------------------------- running

.PHONY: run
run: build ## Run the server and open a browser
	./$(BIN) $(SERVE_FLAGS)

.PHONY: serve
serve: release ## Run the optimised binary
	./$(RELEASE) $(SERVE_FLAGS)

.PHONY: dev
dev: build ## Rust server plus Vite with hot reload (open the Vite URL)
	@echo "==> API on http://$(HOST):$(PORT), UI on http://localhost:$(UI_PORT)"
	@echo "==> open the Vite URL; it proxies /api and /wasm to the server"
	@# `kill 0` signals the whole process group, so Ctrl-C takes both down.
	@trap 'kill 0' EXIT INT TERM; \
	./$(BIN) $(SERVE_FLAGS) --no-open --no-token & \
	FFWEB_API=http://$(HOST):$(PORT) npm --prefix $(WEB) run dev -- --port $(UI_PORT) & \
	wait

.PHONY: doctor
doctor: build ## Report what was found: ffmpeg, codecs, cache
	./$(BIN) doctor

.PHONY: cache
cache: build ## Download the ffmpeg.wasm core into the cache
	./$(BIN) cache fetch

.PHONY: cache-all
cache-all: build ## Also download the multi-threaded core
	./$(BIN) cache fetch --all

# ----------------------------------------------------------------- checking

.PHONY: test
test: ## Run the Rust tests
	cargo test

.PHONY: typecheck
typecheck: $(NODE_MOD) ## Typecheck the frontend
	npm --prefix $(WEB) run typecheck

.PHONY: test-ui
test-ui: $(NODE_MOD) ## Run the frontend tests
	npm --prefix $(WEB) test

.PHONY: test-ops
test-ops: $(NODE_MOD) ## Run every operation through a real ffmpeg
	npm --prefix $(WEB) run test:ffmpeg

.PHONY: test-e2e
test-e2e: release ## Drive the built binary in a real browser
	npm --prefix $(WEB) run test:e2e

.PHONY: lint
lint: $(NODE_MOD) ## Clippy, rustfmt and the TypeScript compiler
	cargo clippy --all-targets -- -D warnings
	cargo fmt --check
	npm --prefix $(WEB) run typecheck

.PHONY: fmt
fmt: ## Format the Rust sources
	cargo fmt

.PHONY: check
# test-ui first: it writes the command fixture the Rust validator test reads.
check: lint test-ui test ## Everything CI would run

.PHONY: screenshots
screenshots: release ## Retake the pictures in the README
	FFWEB_SCREENSHOTS=1 npm --prefix $(WEB) run test:e2e -- screenshots

.PHONY: check-all
check-all: check test-ops test-e2e ## Everything, including ffmpeg and the browser

# ----------------------------------------------------------------- cleaning

.PHONY: clean
clean: ## Remove build output, keeping dependencies
	cargo clean
	rm -rf $(DIST) $(WEB)/tsconfig.tsbuildinfo

.PHONY: distclean
distclean: clean ## Also remove node_modules
	rm -rf $(NODE_MOD)

.PHONY: clean-cache
clean-cache: build ## Delete the downloaded ffmpeg.wasm core
	./$(BIN) cache clear
