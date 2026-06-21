---
name: addlightness-bench
description: >
  Benchmark before/after code snapshots and report the performance delta with
  statistical significance. Runs N=10 timed runs (hyperfine if available, else a
  date+awk fallback) and computes % improvement. Use when the user says "benchmark this",
  "is it faster", "measure the speedup", "compare before and after", "did the trim
  help performance", "time these two", or invokes /addlightness-bench.
  Triggers on /addlightness-bench.
---

# /addlightness-bench -- before/after performance benchmark

Time two runnable commands head-to-head and report whether the difference is
**real** -- not just noise. This is the **measurement** half of addlightness; it
does not trim code (`/addlightness`) and does not measure static weight
(`/addlightness-review`).

## Scope

- Benchmark ONLY. No edits, no weight metrics, no refactoring.
- Input is two commands you can actually run; output is a timing comparison with
  a significance verdict.
- If the user has not trimmed anything yet, point them at `/addlightness`. If
  they want code-weight numbers (LOC/complexity), point them at
  `/addlightness-review`.

## Inputs

The user supplies **two runnable commands**: a *before* command and an *after*
command. Read trailing args / the request as exactly that pair.

- If they hand you two snapshot files instead of commands, ask for (or infer)
  the command that runs each -- e.g. `node old.js` vs `node new.js`,
  `python3 before.py` vs `python3 after.py`.
- Both commands must do the **same work** on the **same input** -- otherwise the
  comparison is meaningless. State the assumption if you have to guess.
- Quote each command so the harness receives it as one argument.

## How to run

Call the benchmark harness once:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/benchmark.sh" \
  --runs 10 --warmup 3 \
  --before '<before-command>' \
  --after  '<after-command>'
```

It uses `hyperfine` when present and falls back to a `date`+`awk` timing loop
when it is not (this plugin assumes neither hyperfine nor any other profiler is
installed, so expect the fallback). It prints one JSON line -- **parse that**, do
not eyeball stdout. The emitted keys are exactly: `before_ms`, `after_ms`,
`pct_change` (negative = after faster), `faster` (bool), `welch_t`,
`significant_at_95` (bool), `runs`, `warmup`, and `tool`. The harness does not
compute median/p95/stddev -- do not expect or report those, even under hyperfine.

## Reporting

Report a compact table, then a one-line verdict:

| metric | value |
| --- | --- |
| before mean (ms) | `before_ms` |
| after mean (ms) | `after_ms` |
| % change | `pct_change` |
| welch t | `welch_t` |
| significant at 95% | `significant_at_95` |

- **% change** (`pct_change`) -- negative means *faster* (after took less time).
  State it as "X% faster" / "X% slower" so the sign is unambiguous.
- **Significance verdict** -- gate every claim on the emitted `significant_at_95`
  bool. The harness flags significance via a Welch t-test against a df-aware
  two-tailed 95% Welch critical value (emitted as `t_crit_95`; ~2.1-2.3 at the
  default N=10), NOT a fixed 1.96 — never recompute the verdict yourself.
  - If `significant_at_95` is **true** -> report the speedup/regression as real.
  - If **false** -> say so plainly: *"No statistically significant difference --
    the observed delta is within run-to-run noise."* Do **not** dress up a
    noise-level delta as a win. A faster-looking mean with `significant_at_95`
    false is not a result.

## Controls

For the numbers to mean anything:

- **Same machine, same conditions.** Run before/after back-to-back / interleaved,
  not at different times of day.
- **Identical N and warmup** for both commands; **discard warmup** runs from the
  stats.
- **Quiesce background load** -- close heavy apps, no concurrent builds; CPU
  contention dwarfs small deltas.
- **Beware subprocess startup variance.** Benchmarking `node x.js` /
  `python3 x.py` includes interpreter startup, which has large jitter. If the
  stddev is on the order of the mean difference, the signal is swamped --
  **recommend more runs (25-30+)** and/or moving the measured work in-process
  rather than per-invocation.
- **No thermal/load drift.** Don't compare a run from an hour ago against a fresh
  one -- rerun both together.

## What NOT to do

- **Never report a single-run number** as a benchmark. One run is an anecdote.
- **Never claim an improvement without passing the significance gate.** No gate,
  no win.
- **Never compare runs taken hours apart** or on different machines -- thermal
  state, background load, and CPU governor drift invalidate the comparison.
- **Never silently swap the commands' work.** If before and after don't compute
  the same result, a timing delta is meaningless -- flag it, don't report it.
- **Don't trim or edit code here** -- that's `/addlightness`.
