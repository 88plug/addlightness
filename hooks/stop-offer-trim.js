#!/usr/bin/env node
/*
 * addlightness — Stop hook (stop-offer-trim.js)
 *
 * Fires after Claude finishes a turn. Detects source files modified recently
 * in the working directory and emits a gentle, advisory suggestion to run
 * /addlightness on them.
 *
 * CONTRACT CAVEAT (best-effort by design):
 *   The exact Stop-hook stdin/stdout contract was NOT evidenced in any studied
 *   reference plugin. Rather than fabricate a rich contract, this hook is
 *   implemented defensively:
 *     - stdin is read best-effort; empty / non-JSON input is tolerated.
 *     - every field access on the parsed payload is guarded.
 *     - stop_hook_active (if present and truthy) short-circuits to avoid loops.
 *     - all output is plain text to stdout (the only injection style besides
 *       the JSON envelope, mirroring the SessionStart plain-text pattern). The
 *       UserPromptSubmit/SubagentStart additionalContext JSON envelope is
 *       intentionally NOT used here.
 *     - the entire body is wrapped in try/catch and ALWAYS exits 0, so a
 *       throwing Stop hook can never break the session.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RECENT_MS = 5 * 60 * 1000; // files touched in the last 5 minutes
const MAX_FILES = 10;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor']);
const SOURCE_EXT = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.py']);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    try {
      if (process.stdin.isTTY) {
        done();
        return;
      }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      // Safety net: never block the turn waiting on stdin.
      setTimeout(done, 1000);
    } catch (_) {
      done();
    }
  });
}

function collectRecentFiles(root, cutoff) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      const name = entry.name;
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        // Skip explicit build/vcs dirs and ALL hidden dirs (.venv, .cache, etc.)
        // which commonly hold recently-touched files unrelated to user edits.
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (!SOURCE_EXT.has(path.extname(name))) continue;
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= cutoff) found.push(full);
        } catch (_) {
          /* unreadable file — skip */
        }
      }
    }
  };
  walk(root, 0);
  return found;
}

async function main() {
  let payload = {};
  try {
    const raw = (await readStdin()).trim();
    if (raw) {
      try {
        payload = JSON.parse(raw) || {};
      } catch (_) {
        payload = {};
      }
    }
  } catch (_) {
    payload = {};
  }

  // Re-entry guard: if Stop is firing because of this hook's own activity,
  // bail silently to avoid loops.
  if (payload && payload.stop_hook_active) {
    process.exit(0);
    return;
  }

  let cwd = process.cwd();
  try {
    if (payload && typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
  } catch (_) {
    /* keep process.cwd() */
  }

  const cutoff = Date.now() - RECENT_MS;
  const files = collectRecentFiles(cwd, cutoff);

  if (files.length === 0) {
    process.exit(0);
    return;
  }

  const names = files.slice(0, 3).map((f) => path.basename(f));
  const more = files.length > names.length ? `, +${files.length - names.length} more` : '';
  const list = names.join(', ') + more;

  process.stdout.write(
    `addlightness: ${files.length} source file(s) changed this session (${list}). ` +
    `Run /addlightness <file> to trim fat and benchmark, or /addlightness-review to just measure.\n`
  );
  process.exit(0);
}

main().catch(() => {
  // A throwing Stop hook must never break the session.
  try { process.exit(0); } catch (_) { /* noop */ }
});
