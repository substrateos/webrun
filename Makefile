.PHONY: test test-external build-webrtc check-webrtc

# Suppress Deno's background update check for all invocations.
export DENO_NO_UPDATE_CHECK := 1

# Resolve the project's pinned Deno binary (bootstrapped by ./webrun).
DENO_BIN := $(shell echo ~/.cache/webrun/deno/deno-*/deno)

# Ensure Deno is available (bootstrap it via ./webrun if needed).
$(DENO_BIN):
	@./webrun --version > /dev/null

# Install npm dependencies (werift) into the webrtc build directory.
src/internal/webrtc/node_modules: src/internal/webrtc/deno.json $(DENO_BIN)
	cd src/internal/webrtc && $(abspath $(DENO_BIN)) install
	@touch src/internal/webrtc/node_modules

# Run all tests: self-test suite + external suite + webrtc bundle reproducibility check.
test: check-webrtc
	$(DENO_BIN) cache --config deno.json webrun.ts
	./webrun --self-test
	$(MAKE) test-external

# Run the external test suite (tests requiring raw Deno: TTY, git, raw network, bundling).
# These run outside the webrun sandbox using the project's pinned Deno binary.
test-external: $(DENO_BIN)
	$(DENO_BIN) test --no-lock -A tests/external/

# Regenerate src/internal/webrtc/bundle.js and verify it matches what's committed.
check-webrtc: src/internal/webrtc/node_modules $(DENO_BIN)
	@echo "Checking webrtc bundle reproducibility..."
	@HASH_BEFORE=$$(shasum -a 256 src/internal/webrtc/bundle.js | cut -d' ' -f1) && \
	 cp src/internal/webrtc/bundle.js src/internal/webrtc/bundle.js.bak && \
	 $(DENO_BIN) run -A --no-check src/internal/webrtc/build.ts && \
	 HASH_AFTER=$$(shasum -a 256 src/internal/webrtc/bundle.js | cut -d' ' -f1) && \
	 mv src/internal/webrtc/bundle.js.bak src/internal/webrtc/bundle.js && \
	 if [ "$$HASH_BEFORE" != "$$HASH_AFTER" ]; then \
	   echo "FAIL: webrtc bundle is not reproducible." >&2; \
	   echo "  committed: $$HASH_BEFORE" >&2; \
	   echo "  generated: $$HASH_AFTER" >&2; \
	   echo "  Run 'make build-webrtc' to update." >&2; \
	   exit 1; \
	 fi
	@echo "webrtc bundle: OK (reproducible)"

# Rebuild the webrtc bundle (updates the committed artifact).
build-webrtc: src/internal/webrtc/node_modules $(DENO_BIN)
	$(DENO_BIN) run -A --no-check src/internal/webrtc/build.ts
