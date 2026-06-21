---
name: addlightness-review
description: >
  Read-only code-weight report. Measures LOC, cyclomatic complexity, import count,
  function count, and nesting depth for one or more files and lists removable 'fat'
  candidates -- WITHOUT changing any code. Use when the user says "how heavy is this",
  "weight report", "what's the fat here", "review weight", "analyze complexity",
  "where can this be trimmed", "is this bloated", or invokes /addlightness-review.
  Triggers on /addlightness-review. Reports only, never edits; to actually apply
  trims use /addlightness.
---

# /addlightness-review -- read-only weight report

Measure code weight and surface removable "fat" candidates. This is the
**diagnostic** half of addlightness: it reports, it never edits. For actual
trimming use `/addlightness`; for performance numbers use `/addlightness-bench`.

## Scope -- READ-ONLY

**This skill NEVER modifies files.** It reads, measures, and reports. Period.

- No `Edit`, no `Write`, no in-place fixes, no "I went ahead and removed it".
- Output is a report the human reads and decides on.
- If the user wants the trims applied, tell them to run `/addlightness <file...>`
  (which spawns the edit-capable `code-trimmer` agent behind an equivalence gate).
- When in doubt, do less: describe the candidate, do not touch the code.

Repeat this contract back to the user if they ask you to "just fix it" here --
review reports, `/addlightness` edits.

## How to run

For each target file, get its weight metrics from the zero-dependency engine.
Two equivalent paths -- prefer the agent for multi-file work, the direct call
for a single quick read:

1. **Via the agent (preferred for >1 file or a fat-candidate narrative):**
   spawn the `weight-analyst` agent. It is read-only by contract (its prompt
   forbids mutating Bash commands; it has no Edit/Write) and returns the metrics
   table plus a ranked fat list and a KEEP list. The agent analyzes one file per
   invocation — spawn one weight-analyst invocation per file and aggregate the
   JSON yourself.

2. **Direct (single file, fastest):**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/weigh.js" path/to/file.js --json
   ```

   The engine emits one JSON object per file with the scalar `weight` plus the
   raw components (`loc`, `cyclomatic`, `imports`, `functions`, `nesting`,
   `tokens`), an `approx` boolean (true = JS/TS regex approximation, false =
   Python ast-accurate), and the `weight_formula` string. Parse the JSON line;
   do not screen-scrape prose. The `approx` flag is the authoritative
   accuracy signal — read it rather than guessing from the language.

   ```
   weight = 1.0*loc + 2.0*cyclomatic + 1.5*imports + 1.0*functions + 3.0*nesting
   ```

   JS/TS metrics are **regex-on-stripped-source approximations** (comments,
   strings, and templates are stripped first). Python metrics come from the
   stdlib `ast` module and are accurate. Say which is which when you report.

Aggregate across all targets into one report. Glob the user's pattern (e.g.
`src/**/*.js`) yourself, then weigh each match.

## Fat categories to flag

For every candidate, report a row -- never an edit:

| field | meaning |
| --- | --- |
| category | one of the categories below |
| location | `file:line` (or `file:start-end`) |
| current | the exact code as it stands |
| proposed | what a trim would look like (for the human, not applied) |
| why-safe | the specific reason removing it preserves behavior |
| risk | `low` / `medium` / `high` -- residual doubt after why-safe |

Categories:

- **single-use-wrapper** -- a function/helper called from exactly one site that
  adds no abstraction value; inlining removes a hop. Confirm the single call
  site with Grep before flagging.
- **impossible-defensive-check** -- a guard that the local control flow or the
  type system already proves can never fire. **Only flag when you can show the
  proof** (the value is produced two lines up, the type is non-null by
  construction, etc.). If the value crosses a trust boundary, it goes on the
  KEEP list instead -- see below.
- **redundant-destructure** -- destructuring then immediately re-wrapping, or
  pulling fields never used.
- **redundant-coercion** -- `Boolean(x)` in a boolean context, `String(x)` in a
  template, `!!x` where truthiness already suffices, `+x` on a known number.
- **dead-branch / unreachable** -- a branch no input can reach, an
  `if (false)`, a `return` followed by code, an arm shadowed by an earlier one.
- **useless-async** -- `async` on a function that never awaits and whose
  caller does not rely on the Promise wrapping. (Flag cautiously -- check call
  sites; removing `async` changes the return type and turns sync throws into
  thrown errors instead of rejected Promises.)
- **restate-comment** -- a comment that restates the next line (`// increment i`
  above `i++`). Why-comments are NOT fat -- never flag those.
- **verbose-identifier** -- an over-long name in a narrow/private scope where a
  shorter one is clearer. Never flag public/exported names.
- **unused-import** -- an import/require with no remaining reference. Confirm
  with Grep across the file (and re-exports) before flagging.

## Output

Produce three sections, in this order:

1. **Metrics table** -- one row per file: `weight | loc | cyclomatic | imports |
   functions | nesting | tokens`, with a total/average row. Note JS=approx,
   Python=ast-accurate.
2. **Ranked fat-candidate list** -- the rows above, sorted by value-to-risk
   (high-confidence, high-payoff first). Group by file.
3. **KEEP list** -- *co-equal in importance to the removals.* Every defensive
   check, validation, guard, or coercion that **looks like fat but must stay**,
   with the reason it stays. The headline reason is the **trust boundary**:
   any value that is externally controlled -- public API parameters, file/socket
   IO, parsed/network/env/user/CLI data -- keeps its validation even if current
   tests pass without it. A passing test suite with well-formed inputs is NOT
   proof the check is dead; it is the #1 way validation gets wrongly stripped.

A review with an empty KEEP list on real code is suspect -- you probably
mislabeled a boundary check as fat.

## Weight interpretation

The scalar is a **relative** before/after metric, not an industry standard.
Lower = lighter. Read the ratios, not raw size:

- **comment/LOC > ~0.25** -- comment-heavy; check whether comments restate code
  (fat) or explain why (keep).
- **high tokens/LOC** -- dense long lines / verbose identifiers / long literals;
  candidate for naming or extraction (report, don't apply).
- **low cyclomatic-per-LOC** -- lots of straight-line filler relative to actual
  decisions; suggests padding, boilerplate, or copy-paste.
- **high LOC/function with low complexity** -- long but simple functions =
  ceremony/padding rather than essential logic.
- **high nesting** -- the heaviest-weighted dimension (3.0); deep nesting is the
  strongest structural-fat signal (early returns / guard clauses often flatten
  it).

**Raw LOC alone is a weak signal** -- a 200-line file of essential branching can
be leaner than a 60-line file of wrappers. Always pair LOC with the complexity
and nesting ratios.

## What NOT to do

- **Never modify a file.** Not even "a tiny obvious one". Report it.
- **Never claim AST precision for JS/TS.** Those numbers are regex
  approximations on stripped source; say "approximate". Python via `ast` may be
  called accurate.
- **Never flag externally-controlled validation as fat.** Trust-boundary checks
  go on the KEEP list, with the boundary named.
- **Never delete why-comments** from the recommendation -- only restate-comments
  are candidates.
- **Don't flag a single-use-wrapper or unused-import without confirming** call
  sites / references via Grep first.
- **Don't present static metrics as a behavioral guarantee** -- they are
  change-magnitude and structural signals. The user's own test suite is the
  only true equivalence proof, and that proof belongs to `/addlightness`, not
  here.
