# addlightness — experiment ledger

Falsification-first campaign log. Numbers pinned to probes, not vibes.
Method weight scales with evidence cost: cheap probe settles → 3-line entry;
contested/multi-hypothesis → full table. Loop until a varied pass is dry.

## Provenance
- machine: Manjaro, node v22.22.2, python3 + stdlib ast; zero npm deps (hard constraint)
- engines: `lib/weigh.js` (regex-on-stripped-source for JS = approx; python3 ast = accurate),
  `lib/equivalence.js` (node:vm syntax gate + regex signature parity for JS; ast for Python)

## Round 1 (laps 1–5, prior) — CONFIRMED & FIXED  [DO-NOT-RE-ATTACK]
69 hypotheses, 48 fixes. 4 criticals, independently re-verified this session:

| # | Defect | Probe | Fix | Verify |
|---|---|---|---|---|
| R1-C1 | `neutralizeModuleSyntax` regex `[^;]` ate embedded PY_SRC template literal → weigh.js self-trim falsely DIFFERENT | `node lib/equivalence.js lib/weigh.js lib/weigh.js` | scoped neutralizer | now `signature-match`, syntax_ok ✅ |
| R1-C2 | shebang `#!` not stripped before vm.Script → parse fail | self-id on `#!`-prefixed file | strip `/^#!.*\n?/` | `signature-match` ✅ |
| R1-C3 | TS `.ts/.tsx/.mts/.cts` type syntax → false DIFFERENT + `regressed.` exit1 | byte-identical TS self-id | degrade to `unknown`, exit0, no sentinel | ✅ graceful |
| R1-C4 | `??` double-counted in JS cyclomatic (ternary matcher caught 2nd `?` of `??`) | `a?.b ?? c` cyclomatic | fix matcher; `?.` not counted | now 2 (correct) ✅ |

## Open ceilings (Round 2 targets — attack with invent/experiment-designer)
- **CEIL-1 (false-NEGATIVE surface of the gate):** what real behavior changes does
  `equivalence.js` call "equivalent" that AREN'T? This is the #1 regression vector
  (CLAUDE.md constraint #2). Candidates to probe: changed default param values,
  reordered side-effects, changed literal constants, removed `await`, swapped `==`/`===`,
  changed closure capture. Gate compares signatures, not bodies — so body-only behavior
  changes may pass. PROVE the miss surface with adversarial before/after pairs.
- **CEIL-2 (JS metric accuracy):** regex approximation vs true AST. Quantify error vs a
  ground-truth count on real files. Invent: can accuracy improve with zero deps
  (optional acorn-if-present fallback? better lexer states?) without breaking the constraint.
- **CEIL-3 (benchmark min-detectable-effect):** given timing noise on this box, what is the
  smallest speedup `benchmark.sh` can call significant? Design the experiment, measure n+spread.


## Round 2 (scientific-method, cheapest-first + invent) — CONFIRMED & FIXED  [DO-NOT-RE-ATTACK]
36 agents, 11 survivors, 11 refuter-confirmed, 18 fixes. final_dry=false (Lap5 still found 1 → not fully clean; diminishing returns).

| # | Defect | Probe | Fix | Re-verified |
|---|---|---|---|---|
| R2-L1S1 | Python: permuting two public def/class names (body-swap area↔circ) reported `modulo-renames`, exit0, GREEN on public-API behavior change | swap two same-arity public fns | stop alpha-normalizing TOP-LEVEL def/class names (public contract) | now `body-changed`, rec_tests ✅ |
| R2-L1S2 | JS: safe default-arg trim where default expr has parens (`cb=fn(1,2)`→`cb=noop`) wrongly `DIFFERENT`+`regressed.` (param capture `[^)]` stopped at first `)`) | export arrow w/ paren default | balanced-paren scan in extractExports | safe trim passes ✅ |
| R2-L2 (×2) | weigh.js metric miscounts (TS type-position arrow counted as fn; regex-literal braces inflating nesting) | hand-count vs sample | lexer-state fixes | functions=1, nesting=1 ✅ |
| **R2-L3 INVENT** | **Gate false-NEGATIVE: 13/13 behavior-changing pairs (==/===, changed literal, removed await, altered default, off-by-one, operator flip, string change, >/>=) passed as `signature-match`** | adversarial before/after suite | **body behavior-leaf detector: multiset diff of literals/operators/await/defaults; export surface held + leaf changed → DIFFERENT+`regressed.`** | **FN-rate 13/13→0/13; R1 safe suite still passes; peer-reviewed accept** ✅ |
| R2-L4 (×13) | docs/hooks/skills drift + refusal-logic gaps | execute hooks, grep claims | 6 confirmed → 13 edits | smoke pass |
| R2-L5 | benchmark.sh t_crit rounding tightened | welch math probe | rounding fix | bash -n ok |

Independently re-verified post-run: safe trims (identical/modulo-renames/signature-match) still pass = NO false-positives introduced by the stricter gate. Behavior changes (==/===, 2→3) now caught with named leaf diff + exit 1.

## Open ceilings carried to Round 3 (NOT closeable as defects)
- **CEIL-2 (JS metric accuracy):** regex/lexer bounded; residual error on destructuring defaults, TS generics, multi-line sigs. Only an optional acorn-if-present fallback would close it — needs a decision (would soften zero-dep purity to opt-in).
- **CEIL-3 (benchmark MDE):** node spawn ~16ms high relative variance → only >~10-15% deltas reach significance at N=10. Inherent to process-spawn micro-bench; needs larger N or non-spawn workload, not an in-script fix.
- **CEIL-1 residual (body-binding):** new leaf-detector catches literal/operator/await/default changes; full body-binding equivalence (which body belongs to which public name after structural rearrangement) remains the AST-diff frontier — documented, rationale for the mandatory "run your own test suite" reminder.

## DECISION (user, 2026-06-20): CEIL-2 → STAY PURE ZERO-DEP
No optional acorn/parser fallback, ever. Constraint #1 unchanged: ZERO npm dependencies everywhere.
Round 3 hardens the regex/lexer best-effort (destructuring defaults, multi-line signatures, TS
generics best-effort), QUANTIFIES residual JS-metric error vs ground truth, and makes docs state
the exact approximation boundary + when to trust the weight number. JS path must NEVER claim AST precision.

## Round 3 (lean, pure zero-dep) — CONFIRMED & FIXED  [DO-NOT-RE-ATTACK]
13 agents, 647K tokens (leaner than R1 953K, R2 1.7M). 7 survivors, 7 refuter-confirmed, 9 fixes.
JS-metric error vs hand-counted ground truth: **6.3% → 0%** across 7 samples.

| # | Defect | Fix | Re-verified |
|---|---|---|---|
| R3-S1 | class body brace never counted as nesting (`class A {` — name before brace, not `class` kw) → under-counted heaviest metric on all class code | `classifyWordBrace()` scans left across header span, returns 'block' if `class` kw present | `class A{m(){if(z){}}}` → nesting=3 ✅ |
| R3-S2 | TS return-type `fn():T {` broke body nesting (brace preceded by type token not `)`) | classifyWordBrace returns 'block' on `): Type {` return annotation | fn→if → nesting=2 ✅ |
| R3-S3 | template-literal `${...}` interpolations blanked wholesale → arrows/ternaries/`&&` inside not counted | stack-based lexer keeps interpolation CODE, blanks only backtick text | 2 arrows+ternary in template → functions=2 cyclomatic=2 ✅ |
| R3-LapB (×2) | docs overstated JS-path precision / weight absoluteness | doc edits: JS=approximation, weight=relative, gate=signal-not-proof | — |
| R3-LapC (×4) | residual edge fixes from final re-pass | — | smoke pass |

False-positive controls (greedier nesting must NOT over-count): object literals=expr, comparisons `a>b`=expr, bare generics `Array<T>`=expr, JSX braces skipped — ALL confirmed not over-counted. Gate both directions still correct (safe trims pass, behavior changes caught exit 1).

## Campaign status after 3 rounds
final_dry STILL false (LapC found 2). Severity is decaying each round: R1 criticals → R2 high (false-negatives) → R3 medium (metric accuracy). Diminishing returns; the residual ceilings (CEIL-1 body-binding AST frontier, CEIL-3 benchmark spawn-noise MDE) are inherent/documented, not closeable under zero-dep. Recommend STOP unless a specific new concern arises.

## FINALIZED — 2026.6.20 (v2026.6.20)
Final lap = full-repo verification + ship gate. No new defects sought (severity decayed to inherent ceilings); this pass confirms shippable state.
- Smoke suite: **17/17 pass** — all .js node --check, all .sh bash -n, 3 JSON manifests valid, weigh engine (json+human), gate both directions (safe trim→identical, behavior change→exit 1), all 3 hooks executed live (session-start emits context exit 0; stop empty-stdin exit 0; stop re-entry guard silent exit 0).
- install.sh: end-to-end exit 0, exec bits set on all engines/hooks/scripts, node+python3 verified.
- Docs coherent: install.sh location correct, README links (LICENSE/CONTRIBUTING.md) present, constraint #2 in all edit-capable surfaces (weight-analyst read-only, correctly omitted).
- No stray cruft (.bak/.r2bak/.r3bak clean).
- Dogfood weights: weigh.js=709.5, equivalence.js=959 (feature-dense gate; cyclomatic inherent to parse-state machine).
SHIP.
