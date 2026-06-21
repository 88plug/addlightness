#!/usr/bin/env node
'use strict';

// SessionStart hook: plain-text stdout becomes hidden session context.
// NOT a JSON envelope -- the {hookSpecificOutput:{...}} envelope is only for
// UserPromptSubmit/SubagentStart. This follows the caveman-activate.js pattern.
// Reads NO stdin (SessionStart derives state from env/files). Exit 0, well
// under the 5s timeout.

const msg = [
  'addlightness ACTIVE -- "Simplify, then add lightness."',
  'Removes code fat while preserving behavior, then benchmarks the speedup.',
  'Commands: /addlightness <files> (trim+bench) | /addlightness-review <files> (read-only weight report) | /addlightness-bench <before> <after> (benchmark snapshots).',
  'Weight = LOC + cyclomatic + imports + functions + nesting. Never strips defensive checks on externally-controlled inputs.',
  'Engine lives in the plugin root: lib/weigh.js (measure) + lib/equivalence.js (safety gate).'
].join('\n');

process.stdout.write(msg);
process.exit(0);
