#!/usr/bin/env bash
# addlightness smoke test — wiring + behavior check. Zero deps (node + python3).
# Exits non-zero on first failure. Run from anywhere.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
pass=0
fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
no()  { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== syntax =="
for js in lib/*.js hooks/*.js; do
  if node --check "$js" 2>/dev/null; then ok "node --check $js"; else no "node --check $js"; fi
done
for sh in scripts/*.sh tests/*.sh install.sh; do
  if bash -n "$sh" 2>/dev/null; then ok "bash -n $sh"; else no "bash -n $sh"; fi
done

echo "== json manifests =="
for j in .claude-plugin/plugin.json .claude-plugin/marketplace.json marketplace-entry.json package.json; do
  if python3 -c "import json,sys;json.load(open('$j'))" 2>/dev/null; then ok "valid JSON $j"; else no "valid JSON $j"; fi
done

echo "== weigh engine =="
printf 'export function add(a,b){\n  if(a>b){return a;}\n  return b;\n}\n' > "$TMP/w.js"
if node lib/weigh.js "$TMP/w.js" --json | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if d and 'weight' in (d[0] if isinstance(d,list) else d) else 1)" 2>/dev/null; then
  ok "weigh.js --json emits weight"; else no "weigh.js --json emits weight"; fi

echo "== equivalence gate (both directions) =="
# safe trim (comment removal) -> NOT regressed
printf 'def add(a,b):\n    return (a+b)\n'  > "$TMP/a.py"
printf 'def add(a,b):\n    # sum\n    return a+b\n' > "$TMP/b.py"
out="$(node lib/equivalence.js "$TMP/a.py" "$TMP/b.py" 2>/dev/null)"; rc=$?
if [ $rc -eq 0 ] && ! printf '%s' "$out" | grep -q 'regressed\.'; then ok "safe trim passes gate"; else no "safe trim passes gate (rc=$rc)"; fi
# behavior change (arity) -> regressed + exit 1
printf 'def add(a,b,c):\n    return a+b+c\n' > "$TMP/d.py"
out="$(node lib/equivalence.js "$TMP/a.py" "$TMP/d.py" 2>/dev/null)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q 'regressed\.'; then ok "behavior change caught (regressed, exit!=0)"; else no "behavior change caught (rc=$rc)"; fi
# self-identity syntax gate
if node lib/equivalence.js lib/weigh.js lib/weigh.js 2>/dev/null | grep -q '"syntax_ok": *true\|"syntax_ok":true'; then ok "self-identity syntax_ok"; else no "self-identity syntax_ok"; fi

echo "== hooks execute =="
if node hooks/session-start.js >/dev/null 2>&1; then ok "session-start.js exit 0"; else no "session-start.js exit 0"; fi
if printf '' | node hooks/stop-offer-trim.js >/dev/null 2>&1; then ok "stop hook empty stdin exit 0"; else no "stop hook empty stdin exit 0"; fi
if printf '{"stop_hook_active":true}' | node hooks/stop-offer-trim.js >/dev/null 2>&1; then ok "stop hook re-entry guard exit 0"; else no "stop hook re-entry guard exit 0"; fi

echo
echo "smoke: $pass passed, $fail failed"
[ $fail -eq 0 ] || exit 1
