#!/usr/bin/env bash
#
# install.sh -- set up the addlightness Claude Code plugin.
#
# Makes the bundled scripts executable, verifies the runtimes the plugin relies
# on (node required; python3 recommended for accurate metrics), smoke-tests the
# weight engine, and prints how to enable the plugin in Claude Code.
#
# Zero dependencies beyond a POSIX shell, node, and (optionally) python3.

set -euo pipefail

# 1. Resolve the plugin directory (absolute, symlink-robust enough for install).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

note()  { printf '  \033[36m-\033[0m %s\n' "$*"; }
ok()    { printf '  \033[32mok\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!!\033[0m %s\n' "$*" >&2; }

printf '\n=== addlightness install ===\n'
printf 'plugin dir: %s\n\n' "$DIR"

# 2. Make scripts executable. The hook .js files are launched via `node`, so the
#    exec bit is cosmetic for them, but setting it is harmless and consistent.
printf 'Setting executable bits...\n'
chmod +x "$DIR/scripts/benchmark.sh" 2>/dev/null && ok "scripts/benchmark.sh" || warn "scripts/benchmark.sh not found"
if compgen -G "$DIR/hooks/"*.js >/dev/null 2>&1; then
  chmod +x "$DIR/hooks/"*.js && ok "hooks/*.js"
else
  warn "no hooks/*.js found"
fi
if compgen -G "$DIR/lib/"*.js >/dev/null 2>&1; then
  chmod +x "$DIR/lib/"*.js && ok "lib/*.js"
else
  warn "no lib/*.js found"
fi
printf '\n'

# 3. Verify runtimes.
printf 'Checking runtimes...\n'
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version)"
else
  warn "node not found -- the weight engine and hooks REQUIRE Node.js. Install it before using the plugin."
fi

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 --version 2>&1 | awk '{print $2}') (accurate Python AST metrics enabled)"
else
  warn "python3 not found -- Python files will fall back to regex approximations instead of AST-accurate metrics."
fi

if command -v hyperfine >/dev/null 2>&1; then
  ok "hyperfine present (benchmarks will use it)"
else
  note "hyperfine not found -- benchmarks use the built-in date+awk fallback (fine, just noisier)."
fi
printf '\n'

# 4. Smoke-test the weight engine on a throwaway file.
printf 'Smoke-testing the weight engine...\n'
if command -v node >/dev/null 2>&1 && [ -f "$DIR/lib/weigh.js" ]; then
  TMP_JS="$(mktemp /tmp/al_smoke.XXXXXX.js)"
  cleanup() { rm -f "$TMP_JS"; }
  trap cleanup EXIT

  cat <<'EOF' > "$TMP_JS"
import os from 'node:os';
function greet(name) {
  if (!name) return 'hello, world';
  return `hello, ${name}`;
}
const where = os.hostname();
console.log(greet(where));
EOF

  if node "$DIR/lib/weigh.js" "$TMP_JS" --json 2>/dev/null | grep -q '"weight"'; then
    ok "weight engine produced a \"weight\" field"
  else
    warn "weight engine did not emit a \"weight\" field -- check lib/weigh.js"
  fi
else
  warn "skipping smoke test (need node and lib/weigh.js)"
fi
printf '\n'

# 5. Enablement guidance.
cat <<EOF
=== Enabling the plugin in Claude Code ===

addlightness loads through a Claude Code plugin marketplace. Once the marketplace
that ships it is added and resolvable, enable the plugin in your settings.json
using the "<plugin>@<marketplace>" form, for example:

    {
      "enabledPlugins": {
        "addlightness@88plug": true
      }
    }

The marketplace name on the right of "@" must match a marketplace Claude Code can
resolve (the one this plugin is published to). See README.md for the marketplace
install command and the up-to-date marketplace name.

Commands once enabled:
    /addlightness         measure -> trim -> verify -> benchmark
    /addlightness-review  read-only weight + fat-candidate report
    /addlightness-bench   before/after benchmark with significance gating

EOF

ok "install complete"
exit 0
