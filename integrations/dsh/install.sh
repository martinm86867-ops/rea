#!/bin/bash
# Install the dsh-rea plugin into a DSH profile, idempotently.
#
# Usage: ./install.sh [profile] [--no-verify]
#   profile     DSH profile name (default: web)
#   --no-verify skip the verification suite
#
# The script installs REA when `rea` is absent, links this directory into the
# profile's package set, and lets DSH's own reconciler append `dsh-rea` to
# dsh.profile.bundles. Re-running it is safe: pnpm reports "Already up to date"
# and the bundle list does not gain a duplicate.

set -euo pipefail

PROFILE="web"
RUN_VERIFY=true
REA_PACKAGE="rea-agents"
REA_VERSION="6.3.0"

for argument in "$@"; do
  case "$argument" in
    --no-verify) RUN_VERIFY=false ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) printf 'install.sh: unknown option %s\n' "$argument" >&2; exit 2 ;;
    *) PROFILE="$argument" ;;
  esac
done

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { printf 'dsh-rea install failed: %s\n' "$1" >&2; exit 1; }

# --- Node ---------------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js is required; install it from https://nodejs.org"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || fail "Node.js 22 or newer is required (found $(node --version))"

# --- DSH launcher -------------------------------------------------------------
# A source checkout runs the CLI through tsx, which resolves from the checkout's
# own node_modules; an installed `dsh` is used directly from any directory.
DSH_CMD=()
DSH_CWD=""
if command -v dsh >/dev/null 2>&1; then
  DSH_CMD=(dsh)
else
  CHECKOUT="${DSH_CHECKOUT:-/home/dev/deepseek-harness-master}"
  BIN="$CHECKOUT/apps/cli/src/bin.ts"
  if [ -f "$BIN" ]; then
    DSH_CMD=(node --import tsx/esm "$BIN")
    DSH_CWD="$CHECKOUT"
  else
    fail "no 'dsh' on PATH and no checkout at $CHECKOUT; set DSH_CHECKOUT to your deepseek-harness checkout"
  fi
fi
printf 'Using DSH launcher: %s%s\n' "${DSH_CMD[*]}" "${DSH_CWD:+ (from $DSH_CWD)}"

# Run the launcher from the directory its module resolution expects.
run_dsh() {
  if [ -n "$DSH_CWD" ]; then
    ( cd "$DSH_CWD" && "${DSH_CMD[@]}" "$@" )
  else
    "${DSH_CMD[@]}" "$@"
  fi
}

# --- REA runtime --------------------------------------------------------------
if command -v rea >/dev/null 2>&1; then
  printf 'REA already installed: %s (%s)\n' "$(command -v rea)" "$(rea --version 2>/dev/null || echo 'unknown version')"
else
  command -v npm >/dev/null 2>&1 || fail "npm is required to install $REA_PACKAGE"
  printf 'Installing %s@%s...\n' "$REA_PACKAGE" "$REA_VERSION"
  npm install --global --prefix "$HOME/.local" "$REA_PACKAGE@$REA_VERSION" >/dev/null
  command -v rea >/dev/null 2>&1 || [ -x "$HOME/.local/bin/rea" ] || fail "npm finished without installing a 'rea' command"
  printf 'Installed REA %s\n' "$("$HOME/.local/bin/rea" --version 2>/dev/null || echo "$REA_VERSION")"
fi

# --- Plugin -------------------------------------------------------------------
printf 'Installing plugin into profile "%s"...\n' "$PROFILE"
run_dsh plugin --profile "$PROFILE" add "$PLUGIN_DIR"
MANIFEST="$HOME/.dsh/profiles/$PROFILE/package.json"
[ -f "$MANIFEST" ] || fail "profile manifest not found at $MANIFEST"
node -e '
  const manifest = require(process.argv[1])
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes("dsh-rea")) {
    console.error("dsh-rea is missing from dsh.profile.bundles")
    process.exit(1)
  }
  if (manifest.dependencies?.["dsh-rea"] === undefined) {
    console.error("dsh-rea is missing from profile dependencies")
    process.exit(1)
  }
' "$MANIFEST" || fail "the profile manifest was not updated as expected"
printf 'Registered: dsh-rea in %s\n' "$MANIFEST"

# --- Verify -------------------------------------------------------------------
if [ "$RUN_VERIFY" = true ]; then
  printf '\nRunning verification...\n'
  node "$PLUGIN_DIR/verify.mjs"
fi

printf '\nDone. The running harness picks the plugin up on its next profile reload;\n'
printf 'a restart of `dsh %s` is guaranteed to include it.\n' "$PROFILE"
