---
name: addlightness
description: >
  Simplify, then add lightness. Analyzes one or more source files for AI-generated
  'code fat', removes it while preserving behavior, verifies the change passes the
  equivalence gate (a structural signal, not a behavioral proof), then benchmarks
  the speedup. Multi-pass: measure -> trim -> verify -> benchmark.
  Use when the user says "add lightness", "trim this code", "remove the fat", "slim down",
  "make this leaner/faster", "simplify and benchmark", or invokes /addlightness.
  Also auto-triggers when the user wants sloppy first-pass AI code made trim and fast.
  Applies edits; for a read-only weight report with no changes use /addlightness-review.
---

# addlightness

"Simplify, then add lightness." — Colin Chapman, Lotus. This skill owns the full
trim-and-benchmark loop: it measures code weight, removes fat without changing
behavior, verifies the change passes the equivalence gate (a change-magnitude/structural
signal, not a behavioral proof), and benchmarks the result. Lower weight
and a statistically significant speedup are the only success conditions.

The user's invocation carries the target file path(s) as trailing text (e.g.
`/addlightness src/parser.js` or "add lightness to lib/foo.py and lib/bar.py").
Read those paths from the request and treat them as the targets. If no path is
given, ask which file(s) to trim — do not guess.

## Scope

- **This skill (`/addlightness`)** owns the WHOLE pipeline: measure -> trim ->
  verify -> benchmark. It both reports and edits.
- **`/addlightness-review`** is READ-ONLY. If the user only wants a weight report
  or a list of fat candidates with no edits, route there instead and stop.
- **`/addlightness-bench`** is BENCHMARK-ONLY. If the user already has a before/after
  pair and only wants the timing comparison, route there instead and stop.

When in doubt about whether the user wants edits, ask once. Default to the full
pipeline only when the request clearly asks to trim, slim, lighten, or speed up
the code.

## Pipeline

Run these steps in order, per target file. Paths below use `${CLAUDE_PLUGIN_ROOT}`,
which Claude Code expands to this plugin's install directory.

1. **Measure BEFORE.** For each target file, capture baseline metrics. Either
   delegate to the `weight-analyst` agent (spawn one weight-analyst invocation
   per file and aggregate the JSON yourself — the agent analyzes one file per
   run) or run the engine directly:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/weigh.js" <file> --json
   ```

   With `--json` this emits one JSON object with `loc`, `cyclomatic`, `imports`,
   `functions`, `nesting`, `weight`, a `tokens` proxy, and an `approx` boolean
   (true = JS/TS regex approximation, false = Python ast-accurate). Parse that
   line; without `--json` the engine prints a human-readable table, not JSON.
   Record the full component set, not just the scalar weight — the report table
   needs every dimension.

2. **Establish a green baseline.** Ask the user to confirm the file's tests pass
   right now (or run them if you know the command). If there is no test coverage,
   say so explicitly and recommend adding characterization tests before trimming.
   Static equivalence checks are change-magnitude signals, not behavioral proof —
   the user's own test suite is the only true runtime-equivalence guarantee.

3. **Trim.** Spawn the `code-trimmer` agent for the file, passing the BEFORE
   metrics and the trust-boundary rule (below). One file per trimmer invocation;
   the trimmer hard-refuses 3+ files of unrelated scope in a single pass.

4. **Verify equivalence.** After the trimmer edits a file, compare the saved
   original against the trimmed version:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/equivalence.js" <before> <after>
   ```

   The gate writes a JSON object whose `equivalent` field is the verdict, then
   exits 0 on a pass. Proceed only when that field is `identical`,
   `modulo-renames`, or `signature-match`. Treat `unknown` (the zero-dep gate
   could not parse the file) and `body-changed` (signatures + behavior-leaves
   match but the body structure changed — a soft signal, no auto-revert) as
   inconclusive — do not auto-revert, but make the "run your tests" reminder
   mandatory and emphasized (`body-changed` is louder than `unknown`). **REVERT the edit and
   report it** when the process exits non-zero, prints the literal `regressed.`
   sentinel, or the `equivalent` field is `DIFFERENT` — never ship a trim that
   fails the gate.

5. **Measure AFTER.** Re-run `weigh.js` on the trimmed file to capture the new
   metrics:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/weigh.js" <file> --json
   ```

6. **Benchmark (when runnable).** If the file (or a target that exercises it) can
   be run as a command, benchmark before vs after:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/benchmark.sh" \
     --runs 10 --warmup 3 \
     --before '<before-command>' \
     --after  '<after-command>'
   ```

   The harness takes flags only (it dies on positional args), uses hyperfine if
   present else a date+awk fallback, and prints a JSON line with `before_ms`,
   `after_ms`, `pct_change` (negative = after faster), `welch_t`, and
   `significant_at_95`. If there is no sensible runtime
   target, skip benchmarking and report a weight-only result — do not fabricate a
   speedup.

## Trust-boundary rule (load-bearing — apply on every defensive-check removal)

**KEEP defensive checks on externally-controlled inputs.** Externally-controlled
means public API parameters, file/network/process IO, parsed data, environment
variables, and anything derived from user input. These validations stay, always.

**Only remove checks on internally-produced or type-guaranteed values** — where the
type system or local control flow already proves the value cannot be the thing the
check guards against.

Never strip input validation. This is the #1 regression vector: tests pass with
well-formed inputs even after a guard is wrongly removed, so the breakage only
surfaces in production with hostile or malformed input.

## Three-pass trim order

The trimmer works in this fixed order so judgment effort is never spent on lines
that a cheaper pass would have deleted anyway.

1. **Mechanical** (zero-judgment, lint-autofixable): remove unused imports / vars /
   exports, no-else-return, useless catch / return / rename / constructor,
   redundant boolean compares and coercions.
2. **Semantic** (judgment): inline single-use wrappers, collapse redundant control
   flow, drop ONLY proven-impossible defensive checks (per the trust-boundary
   rule), remove redundant destructure / coercion.
3. **Style** (cosmetic): shorten identifiers in narrow / private scope only, delete
   what-restating comments, **keep why-comments**.

JS traps the trimmer honors and you must not override: keep `return await` inside
try/catch; don't strip `async` without checking call sites (it changes the return
type and turns sync throws into rejected Promises); don't blanket-delete empty
catch blocks (intentional swallow vs bug is ambiguous).

## Report format

Present a before/after table per file, then the verdict.

| Metric            | Before | After | Delta |
| ----------------- | ------ | ----- | ----- |
| LOC               | …      | …     | …     |
| Cyclomatic        | …      | …     | …     |
| Imports           | …      | …     | …     |
| Functions         | …      | …     | …     |
| Nesting           | …      | …     | …     |
| **Weight**        | …      | …     | …     |

- **Weight reduction:** `(before_weight - after_weight) / before_weight * 100`%.
- **Benchmark:** % speedup with a significance flag. Gate on the harness's
  emitted `significant_at_95` bool (true only when the Welch `|t|` exceeds a
  df-aware two-tailed 95% Welch critical value, emitted as `t_crit_95`, ~2.1-2.3
  at the default N=10); never recompute against a fixed 1.96. Label anything else
  "not statistically significant" and do not claim it as a win.
- **Edit list:** each change tagged `mechanical` | `semantic` | `style` with a
  one-line justification.
- **KEEP list (co-equal):** what was deliberately preserved and why — especially
  every defensive check kept under the trust-boundary rule.

Weight is a RELATIVE before/after metric (lower = lighter), not an absolute
industry standard. Present it as a comparison, never as a grade.

## What NOT to do

- Don't strip validation or defensive checks on externally-controlled inputs.
- Don't change public signatures, exports, thrown-error types, or async contracts.
- Don't claim a speedup that isn't statistically significant.
- Don't refactor files with no test coverage without first recommending (and
  ideally adding) characterization tests.
- Don't edit 3+ files of unrelated scope in one pass — split the work.
- Don't ship a trim that failed the equivalence gate; revert and report it.
- Don't fabricate a benchmark when there's no runnable target — report weight only.
