#!/usr/bin/env bash
#
# benchmark.sh -- before/after timing harness for the addlightness plugin.
#
# WHAT IT DOES
#   Times a "before" command and an "after" command across N timed runs (after
#   W discarded warmup runs), then reports mean and stddev for each side, the
#   percent change, and a Welch's t-test so a noisy result is not sold as a real
#   speedup.
#
# WHY THESE CONTROLS MATTER (read before trusting any number)
#   * Same machine, same shell, same N and W for both sides -- the only fair
#     comparison is one where nothing but the command differs.
#   * Back-to-back / interleaved execution keeps both sides under the same
#     ambient load (other processes, thermal state, CPU governor).
#   * Warmup runs are DISCARDED: the first invocations pay one-time costs (cold
#     file cache, JIT warmup, module resolution) that distort steady-state cost.
#   * The headline claim is GATED on statistical significance. Spawn-dominated
#     micro-benchmarks (node/python startup) are extremely noisy; a raw percent
#     delta on a handful of runs is meaningless on its own. We compute Welch's
#     t (unequal-variance) and only call a change real when |t| exceeds the
#     two-tailed 95% critical value for the Welch-Satterthwaite degrees of
#     freedom (df-aware, NOT a fixed 1.96 — at the default N=10/side the real
#     crit is ~2.10-2.26, so 1.96 would over-report significance). If it is not
#     significant we say so plainly instead of reporting a number that will not
#     reproduce.
#   * Commands that exit non-zero ABORT the run (both hyperfine and fallback
#     paths) — a broken "after" command can never be sold as a speedup.
#
# DEPENDENCIES
#   bash, date (with %N nanoseconds), awk. Uses hyperfine if it happens to be
#   installed (better timer + outlier handling); otherwise a date+awk fallback.
#   python3 is used only to parse hyperfine's JSON when hyperfine is present.
#   No npm packages, no perf, no GNU time required.
#
# USAGE
#   scripts/benchmark.sh [--runs N] [--warmup W] \
#       --before '<command>' --after '<command>'
#
#   Defaults: --runs 10  --warmup 3
#
# OUTPUT
#   A human-readable summary on stderr-ish stdout, followed by a single machine
#   readable JSON line on stdout:
#     {"before_ms":..,"after_ms":..,"pct_change":..,"faster":bool,
#      "welch_t":..,"welch_df":..,"t_crit_95":..,"significant_at_95":bool,
#      "runs":N,"warmup":W,"tool":".."}
#   pct_change is negative when "after" is faster.

set -euo pipefail

RUNS=10
WARMUP=3
BEFORE_CMD=""
AFTER_CMD=""

die() { printf 'benchmark.sh: %s\n' "$*" >&2; exit 2; }

usage() {
  cat >&2 <<'USAGE'
Usage: benchmark.sh [--runs N] [--warmup W] --before '<cmd>' --after '<cmd>'
  --runs N     number of timed iterations per side (default 10)
  --warmup W   number of discarded warmup iterations per side (default 3)
  --before CMD command representing the original code
  --after  CMD command representing the trimmed code
USAGE
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runs)   [ "$#" -ge 2 ] || usage; RUNS="$2"; shift 2 ;;
    --warmup) [ "$#" -ge 2 ] || usage; WARMUP="$2"; shift 2 ;;
    --before) [ "$#" -ge 2 ] || usage; BEFORE_CMD="$2"; shift 2 ;;
    --after)  [ "$#" -ge 2 ] || usage; AFTER_CMD="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$BEFORE_CMD" ] || die "missing --before '<cmd>'"
[ -n "$AFTER_CMD" ]  || die "missing --after '<cmd>'"

case "$RUNS" in (*[!0-9]*|'') die "--runs must be a positive integer";; esac
case "$WARMUP" in (*[!0-9]*|'') die "--warmup must be a non-negative integer";; esac
[ "$RUNS" -ge 2 ] || die "--runs must be >= 2 (need variance for the t-test)"

# Emit the final machine-readable JSON line and the gating message.
# Args: tool before_ms after_ms welch_t before_sd after_sd
emit_verdict() {
  local tool="$1" b_ms="$2" a_ms="$3" t="$4" b_sd="$5" a_sd="$6"

  awk -v tool="$tool" -v b="$b_ms" -v a="$a_ms" -v t="$t" \
      -v bsd="$b_sd" -v asd="$a_sd" -v runs="$RUNS" -v warm="$WARMUP" '
  # Two-tailed t critical value at alpha=0.05 for the given degrees of freedom.
  # A small monotone lookup keeps the gate zero-dep yet df-aware: at the default
  # N=10/side the Welch df is ~9-18 where t_crit is 2.10-2.26, NOT 1.96 — using
  # 1.96 there over-reports significance. We pick the t_crit for the largest
  # table df that does not exceed the actual df (conservative rounding down).
  # df is fractional in nearly every real run; truncate to int, then walk the
  # table descending so we return the crit for the largest table row whose df
  # is <= the actual df. A larger crit (smaller df bucket) is the conservative
  # direction, so this is never less conservative than the stated policy.
  function tcrit(df,  d) {
    d = int(df)
    if (d >= 120) return 1.980
    if (d >= 60)  return 2.000
    if (d >= 40)  return 2.021
    if (d >= 30)  return 2.042
    if (d >= 25)  return 2.060
    if (d >= 20)  return 2.086
    if (d >= 15)  return 2.131
    if (d >= 12)  return 2.179
    if (d >= 10)  return 2.228
    if (d >= 9)   return 2.262
    if (d >= 8)   return 2.306
    if (d >= 7)   return 2.365
    if (d >= 6)   return 2.447
    if (d >= 5)   return 2.571
    if (d >= 4)   return 2.776
    if (d >= 3)   return 3.182
    if (d >= 2)   return 4.303
    if (d >= 1)   return 12.706
    return 12.706
  }
  BEGIN {
    pct = (b > 0) ? (a - b) / b * 100.0 : 0.0
    faster = (a < b) ? "true" : "false"
    abst = (t < 0) ? -t : t

    # Welch-Satterthwaite degrees of freedom. With equal n per side and the
    # sds we already have, compute it directly; guard the all-zero-variance case.
    n1 = runs; n2 = runs
    v1 = (bsd*bsd) / n1
    v2 = (asd*asd) / n2
    denom = (n1 > 1 ? (v1*v1)/(n1-1) : 0) + (n2 > 1 ? (v2*v2)/(n2-1) : 0)
    if (denom > 0) {
      df = (v1 + v2) * (v1 + v2) / denom
    } else {
      df = n1 + n2 - 2   # both sides zero-variance; fall back to pooled df
    }
    crit = tcrit(df)
    sig = (abst > crit) ? "true" : "false"

    printf("\n=== addlightness benchmark ===\n") > "/dev/stderr"
    printf("tool      : %s\n", tool) > "/dev/stderr"
    printf("runs      : %d timed (%d warmup discarded), per side\n", runs, warm) > "/dev/stderr"
    printf("before    : %10.3f ms  (sd %.3f)\n", b, bsd) > "/dev/stderr"
    printf("after     : %10.3f ms  (sd %.3f)\n", a, asd) > "/dev/stderr"
    printf("change    : %+.2f%%  (%s)\n", pct, (a < b) ? "faster" : "slower") > "/dev/stderr"
    printf("welch t   : %.3f  (df %.1f, two-tailed 95%% crit |t|>%.3f)\n", t, df, crit) > "/dev/stderr"
    if (sig == "true")
      printf("verdict   : change IS statistically significant at 95%%\n") > "/dev/stderr"
    else
      printf("verdict   : change NOT statistically significant (likely noise)\n") > "/dev/stderr"
    printf("==============================\n\n") > "/dev/stderr"

    printf("{\"before_ms\":%.3f,\"after_ms\":%.3f,\"pct_change\":%.3f,\"faster\":%s,\"welch_t\":%.3f,\"welch_df\":%.3f,\"t_crit_95\":%.3f,\"significant_at_95\":%s,\"runs\":%d,\"warmup\":%d,\"tool\":\"%s\"}\n",
           b, a, pct, faster, t, df, crit, sig, runs, warm, tool)
  }'
}

# ---------------------------------------------------------------------------
# Path A: hyperfine present. Use it for both sides, parse mean + stddev (in ms)
# from its JSON, then run the same Welch gate on the reported means/stddevs.
# ---------------------------------------------------------------------------
run_with_hyperfine() {
  local b_json a_json
  b_json="$(mktemp /tmp/al_before.XXXXXX.json)"
  a_json="$(mktemp /tmp/al_after.XXXXXX.json)"
  trap 'rm -f "$b_json" "$a_json"' RETURN

  hyperfine --warmup "$WARMUP" --runs "$RUNS" \
    --export-json "$b_json" -- "$BEFORE_CMD" >/dev/null 2>&1 || die "hyperfine failed on --before"
  hyperfine --warmup "$WARMUP" --runs "$RUNS" \
    --export-json "$a_json" -- "$AFTER_CMD"  >/dev/null 2>&1 || die "hyperfine failed on --after"

  # hyperfine reports seconds; convert to ms. results[0].mean / .stddev
  local b_ms a_ms b_sd a_sd
  b_ms="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["results"][0]; print(d["mean"]*1000.0)' "$b_json")"
  a_ms="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["results"][0]; print(d["mean"]*1000.0)' "$a_json")"
  b_sd="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["results"][0]; print((d.get("stddev") or 0.0)*1000.0)' "$b_json")"
  a_sd="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["results"][0]; print((d.get("stddev") or 0.0)*1000.0)' "$a_json")"

  local t
  t="$(awk -v m1="$b_ms" -v s1="$b_sd" -v n1="$RUNS" \
           -v m2="$a_ms" -v s2="$a_sd" -v n2="$RUNS" 'BEGIN {
    se = sqrt((s1*s1)/n1 + (s2*s2)/n2)
    if (se == 0) { print "0.000"; exit }
    printf("%.3f", (m1 - m2) / se)
  }')"

  emit_verdict "hyperfine" "$b_ms" "$a_ms" "$t" "$b_sd" "$a_sd"
}

# ---------------------------------------------------------------------------
# Path B: date+awk fallback. Samples are INTERLEAVED: per iteration i we time
# one before-run then one after-run, so thermal/load drift hits both sides
# equally (a t-test cannot otherwise detect block-level drift). Each sample is
# wall-clock ms via date +%s.%N. A command that exits non-zero ABORTS the run
# (die) so a broken "after" command is never sold as a speedup.
# ---------------------------------------------------------------------------

# Time a single invocation of $1, printing elapsed ms on stdout. Aborts if the
# command exits non-zero (matches the hyperfine `|| die` behavior).
time_once() {
  local cmd="$1" start end
  start="$(date +%s.%N)"
  if ! eval "$cmd" >/dev/null 2>&1; then
    die "command failed during timing (non-zero exit): $cmd"
  fi
  end="$(date +%s.%N)"
  awk -v s="$start" -v e="$end" 'BEGIN { printf("%.6f", (e - s) * 1000.0) }'
}

# Reduce a space-separated list of ms samples to "mean stddev" (sample n-1 form).
reduce_samples() {
  printf '%s' "$1" | awk '{
    n = NF
    for (i = 1; i <= n; i++) { x[i] = $i; sum += $i }
    mean = sum / n
    ss = 0
    for (i = 1; i <= n; i++) { d = x[i] - mean; ss += d * d }
    sd = (n > 1) ? sqrt(ss / (n - 1)) : 0
    printf("%.6f %.6f", mean, sd)
  }'
}

run_with_fallback() {
  printf 'benchmark.sh: hyperfine not found; using date+awk fallback timer.\n' >&2

  # Fail loud if this platform's date has no nanosecond support (BSD/macOS date
  # emits a literal 'N'); otherwise (e-s) is non-numeric and timings are garbage.
  case "$(date +%N)" in
    (*[!0-9]*|'') die "date does not support %N (nanoseconds); install GNU coreutils (gdate) or run on Linux" ;;
  esac

  local i b_samples="" a_samples=""

  # Warmup: discard W interleaved before/after runs (cold cache, JIT, module
  # resolution). Warmups also abort on failure so a broken command fails early.
  i=0
  while [ "$i" -lt "$WARMUP" ]; do
    time_once "$BEFORE_CMD" >/dev/null
    time_once "$AFTER_CMD"  >/dev/null
    i=$((i + 1))
  done

  # Timed runs, interleaved: before sample i, then after sample i.
  i=0
  while [ "$i" -lt "$RUNS" ]; do
    b_samples="$b_samples $(time_once "$BEFORE_CMD")"
    a_samples="$a_samples $(time_once "$AFTER_CMD")"
    i=$((i + 1))
  done

  local b_out a_out b_ms b_sd a_ms a_sd
  b_out="$(reduce_samples "$b_samples")"
  a_out="$(reduce_samples "$a_samples")"

  b_ms="${b_out%% *}"; b_sd="${b_out##* }"
  a_ms="${a_out%% *}"; a_sd="${a_out##* }"

  local t
  t="$(awk -v m1="$b_ms" -v s1="$b_sd" -v n1="$RUNS" \
           -v m2="$a_ms" -v s2="$a_sd" -v n2="$RUNS" 'BEGIN {
    se = sqrt((s1*s1)/n1 + (s2*s2)/n2)
    if (se == 0) { print "0.000"; exit }
    printf("%.3f", (m1 - m2) / se)
  }')"

  emit_verdict "date+awk" "$b_ms" "$a_ms" "$t" "$b_sd" "$a_sd"
}

if command -v hyperfine >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  run_with_hyperfine
else
  run_with_fallback
fi
