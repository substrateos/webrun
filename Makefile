.PHONY: test test-suite build-webrtc check-webrtc

# Suppress Deno's background update check for all invocations.
export DENO_NO_UPDATE_CHECK := 1

# Resolve the project's pinned Deno binary deterministically.
# Evaluates the webrun launcher up to the "end preamble" sentinel (no side
# effects) to compute the exact version+SHA path.
HASH := \#
DENO_BIN := $(shell bash -c 'eval "$$(sed -n "1,/^$(HASH) --- end preamble ---/p" webrun)"; echo "$$DENO_BIN"')

# Bootstrap the Deno binary if it hasn't been downloaded yet.
$(DENO_BIN):
	@./webrun --version > /dev/null

# Install npm dependencies (werift) into the webrtc build directory.
src/internal/webrtc/node_modules: src/internal/webrtc/deno.json $(DENO_BIN)
	cd src/internal/webrtc && $(abspath $(DENO_BIN)) install
	@touch src/internal/webrtc/node_modules

# Which webrun binary the test suite exercises. Exported so Deno sees it.
export WEBRUN_BIN ?= $(CURDIR)/webrun

# Run self-test + external tests against $(WEBRUN_BIN).
test-suite: $(DENO_BIN)
	$(WEBRUN_BIN) --test tests/webrun.test.ts
	$(DENO_BIN) test --no-lock -A tests/external/

# Run all tests: unbundled suite + bundled suite + webrtc bundle reproducibility check.
test: check-webrtc
	$(DENO_BIN) cache --config deno.json webrun.ts
	@echo "=== Unbundled ==="
	$(MAKE) test-suite
	@echo "=== Bundled ==="
	./webrun --self-bundle > webrun_bundled
	chmod +x webrun_bundled
	$(MAKE) test-suite WEBRUN_BIN=$(CURDIR)/webrun_bundled
	rm webrun_bundled

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
