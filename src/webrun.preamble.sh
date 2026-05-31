#!/bin/bash

# All env vars are controlled by the user, so we have to be careful.
# Use bash builtins (echo, [, [[, pushd, popd, cd, pwd, export, trap, wait,
# kill, shift, exec, read, printf) over external tools where possible.

# Absolute paths for all external commands
_uname=/usr/bin/uname
_id=/usr/bin/id
_mkdir=/bin/mkdir
_rm=/bin/rm
_chmod=/bin/chmod
_curl=/usr/bin/curl
_unzip=/usr/bin/unzip
_grep=/usr/bin/grep
_awk=/usr/bin/awk
_cat=/bin/cat
_mktemp=/usr/bin/mktemp
_readlink=/usr/bin/readlink
_basename=/usr/bin/basename
_kill=/bin/kill

# Checksum: prefer sha256sum (Linux), fall back to shasum (macOS)
if [ -x /usr/bin/sha256sum ]; then
  _checksum="/usr/bin/sha256sum -c"
elif [ -x /usr/bin/shasum ]; then
  _checksum="/usr/bin/shasum -a 256 -c"
else
  _checksum=""
fi

# Determine OS and Architecture to match Deno's naming convention
OS=$($_uname -s)
ARCH=$($_uname -m)

if [ "$OS" = "Darwin" ]; then
  if [ "$ARCH" = "arm64" ]; then
    DENO_TARGET="aarch64-apple-darwin"
    EXPECTED_SHA="dba813b8b69d6218cffb11252b9e4e6036ca2c9d79843cde367b4b369aaf9634"
  elif [ "$ARCH" = "x86_64" ]; then
    DENO_TARGET="x86_64-apple-darwin"
    EXPECTED_SHA="d6eb643b7f1afb22139f4aa17c4d97bf7ddab4e01e1820edcb30b9ae5c3a7391"
  fi
elif [ "$OS" = "Linux" ]; then
  if [ "$ARCH" = "aarch64" ]; then
    DENO_TARGET="aarch64-unknown-linux-gnu"
    EXPECTED_SHA="933a6a7d2985957271cd2085a5a5a1832398aa221a354daab5635196cf2cbbae"
  elif [ "$ARCH" = "x86_64" ]; then
    DENO_TARGET="x86_64-unknown-linux-gnu"
    EXPECTED_SHA="be2c8b53c8ca1d66be76feb9b1a524419da708b00d4ca074cf5c633c81c1627b"
  fi
fi

if [ -z "$DENO_TARGET" ]; then
  echo "Unsupported architecture: $OS $ARCH" >&2
  exit 1
fi

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "${SOURCE%/*}" >/dev/null 2>&1 && pwd )"
  SOURCE="$($_readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$( cd -P "${SOURCE%/*}" >/dev/null 2>&1 && pwd )"
export WEBRUN_BIN="$SCRIPT_DIR/${SOURCE##*/}"
export WEBRUN_VERSION="dev"

# Embedded by bundle/webrun.ts — byte offsets and SHAs for cached extraction.
MAIN_SHA=dev
WORKER_SHA=dev
TEST_ADAPTER_SHA=dev
WEBRTC_SHA=dev
MAIN_OFFSET=0
MAIN_SIZE=0
WORKER_OFFSET=0
WORKER_SIZE=0
TEST_ADAPTER_OFFSET=0
TEST_ADAPTER_SIZE=0
WEBRTC_OFFSET=0
WEBRTC_SIZE=0

DENO_VERSION="v2.8.0"

unset DENO_AUTH_TOKENS \
  DENO_TLS_CA_STORE \
  DENO_CERT \
  NODE_EXTRA_CA_CERTS \
  DENO_COVERAGE_DIR \
  DENO_DIR \
  DENO_INSTALL_ROOT \
  DENO_REPL_HISTORY \
  DENO_NO_PACKAGE_JSON \
  DENO_NO_PROMPT \
  DENO_NO_UPDATE_CHECK \
  DENO_V8_FLAGS \
  DENO_JOBS \
  DENO_KV_ACCESS_TOKEN \
  DENO_AUDIT_PERMISSIONS \
  DENO_WEBGPU_TRACE \
  DENO_WEBGPU_BACKEND \
  HTTP_PROXY \
  HTTPS_PROXY \
  NPM_CONFIG_REGISTRY \
  NO_COLOR \
  NO_PROXY

# Resolve the user's home directory from the kernel UID, not from $HOME.
# id -u is a getuid() syscall — unforgeable via environment variables.
if [ "$OS" = "Darwin" ]; then
  WEBRUN_HOME=$(/usr/bin/dscl . -read "/Users/$($_id -un)" NFSHomeDirectory 2>/dev/null | $_awk '{print $2}')
else
  WEBRUN_HOME=$(/usr/bin/getent passwd "$($_id -u)" 2>/dev/null | while IFS=: read -r _ _ _ _ _ home _; do echo "$home"; done)
fi

if [ -z "$WEBRUN_HOME" ] || [ ! -d "$WEBRUN_HOME" ]; then
  echo "Error: Could not resolve home directory from UID $($_id -u)." >&2
  echo "  Refusing to fall back to \$HOME to prevent environment injection attacks." >&2
  exit 1
fi
export WEBRUN_HOME

if [ "$OS" = "Darwin" ]; then
  _systmp=$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)
else
  _systmp=/tmp/
fi
WEBRUN_TEMP=$($_mktemp -d "${_systmp}webrun.XXXXXX")
WEBRUN_TEMP=$(cd "$WEBRUN_TEMP" && pwd -P)
export WEBRUN_TEMP

# No environment variable (HOME, XDG_CACHE_HOME, WEBRUN_DENO_DIR) may influence
# the path to the Deno binary.
WEBRUN_CACHE_DIR="$WEBRUN_HOME/.cache/webrun"
WEBRUN_DATA_DIR="$WEBRUN_HOME/.webrun"
export WEBRUN_CACHE_DIR WEBRUN_DATA_DIR
DENO_DIR="$WEBRUN_CACHE_DIR/deno/deno-${DENO_VERSION}-${DENO_TARGET}-${EXPECTED_SHA}"
DENO_BIN="$DENO_DIR/deno"

# Do not let deno check for updates. It's slow and we don't need it.
export DENO_NO_UPDATE_CHECK=1
export DENO_NO_PACKAGE_JSON=1
export DENO_NO_PROMPT=1

# --- end preamble ---

if [ ! -f "$DENO_BIN" ]; then
  echo "Downloading Deno ${DENO_VERSION} for $DENO_TARGET..." >&2
  $_mkdir -p "$DENO_DIR"
  
  ZIP_NAME="deno-${DENO_TARGET}.zip"
  $_curl -fsSL "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/${ZIP_NAME}" -o "$DENO_DIR/${ZIP_NAME}"
  echo "${EXPECTED_SHA}  ${ZIP_NAME}" > "$DENO_DIR/${ZIP_NAME}.sha256sum"

  pushd "$DENO_DIR" > /dev/null
  if [ -n "$_checksum" ]; then
    echo "Verifying checksum..." >&2
    if ! $_checksum "${ZIP_NAME}.sha256sum" >&2; then
      echo "Error: Checksum verification failed!" >&2
      popd > /dev/null
      $_rm -f "$DENO_DIR/${ZIP_NAME}" "$DENO_DIR/${ZIP_NAME}.sha256sum"
      exit 1
    fi
  else
    echo "Warning: checksum utility not found, skipping validation." >&2
  fi
  popd > /dev/null

  $_unzip -q -o "$DENO_DIR/${ZIP_NAME}" -d "$DENO_DIR"
  $_rm -f "$DENO_DIR/${ZIP_NAME}" "$DENO_DIR/${ZIP_NAME}.sha256sum"
  $_chmod +x "$DENO_BIN"
fi

if [[ "$1" == "--self-unbundle" ]]; then
  if [ "$MAIN_SHA" = "dev" ]; then
    echo "Error: Executable is not bundled (run 'make build' first)." >&2
    exit 1
  fi
  DEST_DIR="${2:-webrun-src}"
  $_mkdir -p "$DEST_DIR"
  $_awk '/^__DATA__/ {exit} {print}' "$SOURCE" > "$DEST_DIR/webrun"
  $_chmod +x "$DEST_DIR/webrun"
  $_awk '/^__README_DATA__/ {flag=1; next} /^__LICENSE_DATA__/ {flag=0} flag {print}' "$SOURCE" > "$DEST_DIR/README.md"
  $_awk '/^__LICENSE_DATA__/ {flag=1; next} /^__DENO_JSON_DATA__/ {flag=0} flag {print}' "$SOURCE" > "$DEST_DIR/LICENSE"
  $_awk '/^__DENO_JSON_DATA__/ {flag=1; next} /^__DENO_LOCK_DATA__/ {flag=0} flag {print}' "$SOURCE" > "$DEST_DIR/deno.json"
  $_awk '/^__DENO_LOCK_DATA__/ {flag=1; next} flag {print}' "$SOURCE" > "$DEST_DIR/deno.lock"

  "$DENO_BIN" run -A --no-config - "$SOURCE" "$DEST_DIR" << 'EOF'
  const sourceFile = Deno.args[0];
  const destDir = Deno.args[1];
  const b = Deno.readTextFileSync(sourceFile);
  const re = /sourceMappingURL=data:application\/json;base64,([a-zA-Z0-9+/=]+)/g;
  let m;
  while((m = re.exec(b)) !== null) {
    const binString = atob(m[1]);
    const bytes = new Uint8Array(binString.length);
    for (let i = 0; i < binString.length; i++) {
      bytes[i] = binString.charCodeAt(i);
    }
    const sm = JSON.parse(new TextDecoder().decode(bytes));
    if (!sm.sources) continue;
    for (let i = 0; i < sm.sources.length; i++) {
      const s = sm.sources[i];
      const c = sm.sourcesContent ? sm.sourcesContent[i] : null;
      if(!c) continue;
      let outPath;
      if (s.startsWith('http://') || s.startsWith('https://')) {
        const u = new URL(s);
        outPath = 'vendor/' + u.hostname + u.pathname;
      } else {
        outPath = s;
      }
      const full = destDir + '/' + outPath;
      const dir = full.substring(0, full.lastIndexOf('/'));
      Deno.mkdirSync(dir, {recursive:true});
      Deno.writeTextFileSync(full, c);
    }
  }
EOF
  echo "Successfully unbundled webrun source to $DEST_DIR"
  exit 0
fi

# Handle --version early so bootstrapping (Makefile) can trigger Deno download
# without requiring a built executable.
if [[ "$1" == "--version" ]] || [[ "$1" == "-v" ]]; then
  echo "webrun $WEBRUN_VERSION"
  exit 0
fi

# Require bundled executable — run 'make build' to produce it.
if [ "$MAIN_SHA" = "dev" ]; then
  echo "Error: webrun is not built. Run 'make build' first." >&2
  exit 1
fi

# Extract JS artifacts to content-addressed cache.
# Byte-offset extraction — immune to content collisions.
_webrun_cache="$WEBRUN_CACHE_DIR/webrun/$WEBRUN_VERSION"
_main_path="$_webrun_cache/main-${MAIN_SHA}.js"
_worker_path="$_webrun_cache/worker-${WORKER_SHA}.js"
_test_adapter_path="$_webrun_cache/test_adapter-${TEST_ADAPTER_SHA}.js"
_webrtc_path="$_webrun_cache/webrtc-${WEBRTC_SHA}.js"

_verify_sha() {
  local file="$1" expected="$2"
  if [ -n "$_checksum" ]; then
    echo "$expected  $file" | $_checksum - >/dev/null 2>&1
    return $?
  fi
  return 0
}

if [ ! -f "$_main_path" ] || [ ! -f "$_worker_path" ] || [ ! -f "$_test_adapter_path" ] || [ ! -f "$_webrtc_path" ]; then
  $_mkdir -p "$_webrun_cache"
  _tmp_main=$($_mktemp "$_webrun_cache/main.XXXXXX")
  _tmp_worker=$($_mktemp "$_webrun_cache/worker.XXXXXX")
  _tmp_test_adapter=$($_mktemp "$_webrun_cache/test_adapter.XXXXXX")
  _tmp_webrtc=$($_mktemp "$_webrun_cache/webrtc.XXXXXX")
  dd bs=1 skip=$MAIN_OFFSET count=$MAIN_SIZE < "$SOURCE" > "$_tmp_main" 2>/dev/null
  dd bs=1 skip=$WORKER_OFFSET count=$WORKER_SIZE < "$SOURCE" > "$_tmp_worker" 2>/dev/null
  dd bs=1 skip=$TEST_ADAPTER_OFFSET count=$TEST_ADAPTER_SIZE < "$SOURCE" > "$_tmp_test_adapter" 2>/dev/null
  dd bs=1 skip=$WEBRTC_OFFSET count=$WEBRTC_SIZE < "$SOURCE" > "$_tmp_webrtc" 2>/dev/null
  if ! _verify_sha "$_tmp_main" "$MAIN_SHA" || ! _verify_sha "$_tmp_worker" "$WORKER_SHA" || ! _verify_sha "$_tmp_test_adapter" "$TEST_ADAPTER_SHA" || ! _verify_sha "$_tmp_webrtc" "$WEBRTC_SHA"; then
    echo "Error: extracted JS artifacts failed checksum verification." >&2
    exit 1
  fi
  mv "$_tmp_main" "$_main_path"
  mv "$_tmp_worker" "$_worker_path"
  mv "$_tmp_test_adapter" "$_test_adapter_path"
  mv "$_tmp_webrtc" "$_webrtc_path"
fi

export WEBRUN_MAIN="$_main_path"
export WEBRUN_WORKER="$_worker_path"
export WEBRUN_TEST_ADAPTER="$_test_adapter_path"
export WEBRUN_WEBRTC_BUNDLE="$_webrtc_path"
export WEBRUN_README_PATH="$WEBRUN_BIN"
export WEBRUN_README_BEGIN=__README_DATA__
export WEBRUN_README_END=__LICENSE_DATA__

HOME="$WEBRUN_HOME" exec "$DENO_BIN" run \
  -A \
  --no-check \
  --no-config \
  --quiet \
  --unstable-worker-options \
  --unstable-net \
  --unstable-ffi \
  "$WEBRUN_MAIN" "$@"

