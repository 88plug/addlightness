# addlightness — maintainer guide

This file is for people (and agents) working **on** the plugin. For how to
**use** it, read `README.md`. This document is the architecture, the design
contract, and the non-obvious traps.

## 1. Thesis

Colin Chapman, founder of Lotus: *"Simplify, then add lightness."* You don't
make a car fast by adding power — you make it fast by removing weight.

This plugin operationalizes that for code. We define **code fat** precisely:

> Code fat = anything deletable without changing observable behavior or test
> outcomes.

That definition is the whole game. Everything here exists to (a) measure weight,
(b) remove fat, and (c) **prove** the removal didn't change behavior before
reporting success. "Looks cleaner" is not the bar; "provably no behavior change,
and lighter" is.

## 2. Repo layout

```
.claude-plugin/plugin.json   manifest + hook wiring (the ONLY place hooks are declared)
hooks/
  session-start.js           SessionStart: plain-text context injector (plugin is active + commands)
  stop-offer-trim.js         Stop: best-effort advisory ("N files changed — run /addlightness")
lib/
  weigh.js                   the zero-dep weight engine (metrics -> JSON)
  equivalence.js             the safety GATE (syntax + structural/signature diff)
scripts/
  benchmark.sh               timing harness (hyperfine if present, else date+awk), Welch-gated
install.sh                   (repo root) make executable, verify node/python3, sanity-check the engine
skills/
  addlightness/SKILL.md          /addlightness — full measure->trim->verify->bench pipeline
  addlightness-review/SKILL.md   /addlightness-review — read-only weight + fat-candidate report
  addlightness-bench/SKILL.md    /addlightness-bench — benchmark before/after with significance
agents/
  weight-analyst.md          READ-ONLY measurement agent (tools: Read, Grep, Glob, Bash; model: haiku)
  code-trimmer.md            edit-capable trimming agent (tools: Read, Edit, Write, Grep, Glob, Bash)
README.md                    user-facing landing page
CLAUDE.md                    this file
package.json                 npm/discoverability metadata (Claude Code ignores it for plugin meta)
marketplace-entry.json       88plug registry listing
```

**What lives where, by responsibility:** measurement is `lib/weigh.js` +
`agents/weight-analyst.md`. Safety is `lib/equivalence.js` + the gate language
repeated across the agents/skills. Orchestration is
`skills/addlightness/SKILL.md`. Hooks are pure UX nudges and carry no logic that
the pipeline depends on.

## 3. Hard constraints (the design contract)

These are not preferences. Breaking one is a regression in itself.

1. **ZERO npm dependencies, everywhere.** No `acorn`, `babel`, `typescript`,
   `esprima`. The target machines have none, and we will not add a `node_modules`
   to a "make code lighter" tool. Consequence: **JS/TS metrics and the JS syntax
   gate are approximations** built on regex-over-stripped-source and a classic
   `node:vm` parse. **Python metrics and the Python equivalence check are
   accurate** because they use the stdlib `ast` module via spawned `python3`.
   Never claim AST precision for the JS path.

2. **Never strip defensive checks on externally-controlled inputs.** This is the
   #1 regression vector, because a test suite full of well-formed inputs still
   passes after you wrongly delete input validation. Externally-controlled =
   public API params, IO, parsed/network/env/user data. Those checks are KEPT.
   Only internally-produced or type-guaranteed values are removal candidates.
   This rule is repeated verbatim in both agents, both relevant skills, and the
   README — keep it in sync if you touch one.

3. **Every trim is gated by `lib/equivalence.js` before being reported as
   success.** If the gate returns `DIFFERENT` (or emits the `regressed.`
   sentinel), the edit is reverted, not shipped.

4. **Every benchmark claim is gated by Welch-style significance.** A speedup is
   only reported when the Welch `|t|` exceeds a df-aware two-tailed 95% Welch
   critical value (emitted as `t_crit_95`; ~2.1-2.3 at the default N=10).
   `benchmark.sh` computes NO confidence intervals — gate on the emitted
   `significant_at_95` bool, never recompute against a fixed 1.96. Otherwise it
   is reported as "no significant change". No cherry-picked single runs.

## 4. Hook contracts (including the documented gap)

Claude Code has **two distinct hook stdout contracts** and they must not be
conflated:

- **SessionStart** (`session-start.js`): reads NO stdin. Writes **raw plain
  text** to stdout, which Claude Code injects as hidden session context. This is
  the `caveman-activate.js` pattern. It is **NOT** a JSON envelope. We use it to
  announce the plugin is active, list the three commands, and state the
  trust-boundary promise. `exit(0)`, trivially under the 5s timeout.

- **The JSON envelope** `{ hookSpecificOutput: { hookEventName, additionalContext } }`
  belongs to **UserPromptSubmit / SubagentStart**. The blocking form
  `{ decision: 'block', reason }` belongs there too. **This plugin uses neither
  of those events**, so it never emits that envelope. Don't add it to
  SessionStart — it would be wrong there.

- **Stop** (`stop-offer-trim.js`): **the exact Stop stdin/stdout contract was not
  evidenced in any reference plugin we studied.** It is therefore implemented
  **defensively / best-effort**, and that gap is documented here and in the hook
  file header rather than papered over. Specifically it:
  - reads stdin defensively (accumulate chunks, `JSON.parse` in `try/catch`,
    tolerate empty / non-JSON input);
  - honors a `stop_hook_active` re-entry guard (exit 0 silently if set, to avoid
    a Stop->Stop loop);
  - scans `cwd` for source files modified in the last ~5 minutes (skipping
    `node_modules/.git/dist/build`, capped at ~10);
  - if any exist, writes one short advisory plain-text line
    (`N files changed — run /addlightness <file>`) and exits 0; otherwise writes
    nothing and exits 0;
  - wraps the entire body in `try/catch` that **still exits 0**, so a throwing
    hook never breaks the session.

  If you ever find the authoritative Stop contract, tighten this file — but keep
  the always-exit-0 guarantee.

**`plugin.json` nesting** is two levels:
`EventName -> [ { matcher?, hooks: [ { type, command, timeout, statusMessage } ] } ]`.
`matcher` is an optional GROUP-level field (omitted here = match all). `timeout`
is in **SECONDS** (5), not milliseconds. Scripts are referenced via
`node "${CLAUDE_PLUGIN_ROOT}/hooks/<file>.js"`.

**`plugin.json` wires hooks ONLY.** Skills (`skills/*/SKILL.md`) and agents
(`agents/*.md`) are **auto-discovered** from their directories and **must not**
appear as keys in `plugin.json`. Their absence there is correct by design. There
is no `mcpServers` key — this plugin ships no MCP server.

## 5. Weight formula

`lib/weigh.js` computes a single scalar plus its components:

```
weight = 1.0*LOC + 2.0*cyclomatic + 1.5*imports + 1.0*functions + 3.0*nesting
```

Where, per file:

- **LOC** — non-blank, non-comment lines.
- **cyclomatic** — `1 + decision points`.
  - JS: `if / for / while / case / catch` + `&& || ?? ?:` operators.
  - Python (via `ast`): `If / For / While / ExceptHandler / With / comprehension
    / IfExp / match_case`, plus `len(values)-1` per `BoolOp`.
- **imports** — JS: `import` statements + `require()` calls. Python:
  `sum(len(names))` over `Import` / `ImportFrom`.
- **functions** — JS: function + class + arrow count (approx). Python:
  `FunctionDef + AsyncFunctionDef + ClassDef`.
- **nesting** — JS: max brace depth. Python: max AST block depth.

Coefficients deliberately weight the fat-discriminating dimensions hardest:
**nesting (3.0)** and **cyclomatic (2.0)** penalize structural complexity most,
**imports (1.5)** penalizes speculative-dependency surface, **LOC and functions
(1.0)** are baseline size.

This number is a **relative before/after comparison metric (lower = lighter)**,
NOT an absolute industry standard. Don't present it as one.

```
% weight reduction = (before_weight - after_weight) / before_weight * 100
```

`weigh.js` also emits a `tokens` proxy (whitespace-split word count) and the raw
component metrics so callers can render a full before/after table, not just the
scalar.

## 6. Adding a metric / skill / agent

- **New metric:** edit `lib/weigh.js` only. Add the component to BOTH the JS
  (regex-on-stripped-source) and Python (`ast`) paths, add its coefficient to the
  weight sum, and surface the raw value in the emitted JSON so the before/after
  table can show it. Update the formula in §5 here and in the README.

- **New skill:** create `skills/<name>/SKILL.md` with YAML frontmatter
  (`name:` + `description:` only — skills carry no `tools`/`model`/`args`) and a
  markdown body. **Do not** add it to `plugin.json`; it is auto-discovered. Make
  the `description:` rich and trigger-specific — the model uses it to decide when
  to invoke.

- **New agent:** create `agents/<name>.md` with frontmatter
  (`name:` + `description:` + `tools:`, optionally `model:`) and a body that is
  the agent's full system prompt. **Do not** add it to `plugin.json`; it is
  auto-discovered. Capability restriction lives on the agent's `tools:` list —
  e.g. read-only agents omit `Edit`/`Write`. Note: `weight-analyst` carries
  `Bash`, so its read-only-ness is **instruction-enforced** (its prompt forbids
  mutating commands), NOT capability-enforced — Bash can run `sed -i`/`rm`/
  overwriting redirects. Skills must not claim "read-only by toolset".

- **New hook:** this is the ONLY thing that goes in `plugin.json`, under the
  two-level nesting in §4. Mind the plain-text-vs-JSON contract for the event you
  target.

## 7. Known build-workflow classifier sensitivity

When rebuilding this plugin via the Workflow tool, research agents that are
directed to **search `~/.claude/plugins/cache/` broadly** (e.g. `find ... -name
"*.js" | xargs grep ...`) will traverse installed plugin dirs that contain files
with dense technical vocabulary unrelated to this project. Opus-tier subagents
may trip a model-level safety check on those reads.

**Prevention:** scope plugin-cache reads to specific, named subdirs only
(e.g. `~/.claude/plugins/cache/88plug/caveman-plus/` and `scientific-method/`).
Never use an open `find ~/.claude/plugins/cache -name "*.js" ...` sweep in
a research subagent prompt.

The agent that failed during the initial build was `research:workflow-patterns`
(label R8). The workflow completed successfully because `parallel()` filters null
results; R8's findings were not load-bearing (the blueprint used the other 9).
If rebuilding, consider dropping R8 or scoping it to `~/.claude/workflows/` only.

## 8. Testing

There is no test runner dependency (zero-dep constraint), so verify by running
the engines directly on `/tmp` samples and checking against hand counts.

**`lib/equivalence.js`** — verify each rung of the ladder:

```sh
# Python — identical modulo formatting/comments  -> "identical", exit 0
printf 'def add(a,b):\n    return (a+b)\n'  > /tmp/a.py
printf 'def add(a,b):\n    # sum\n    return a+b\n' > /tmp/b.py
node lib/equivalence.js /tmp/a.py /tmp/b.py

# Python — rename only -> "modulo-renames"
printf 'def add(x,y):\n    return x+y\n' > /tmp/c.py
node lib/equivalence.js /tmp/a.py /tmp/c.py

# Python — arity change -> "DIFFERENT" + prints `regressed.` + exit 1
printf 'def add(a,b,c):\n    return a+b+c\n' > /tmp/d.py
node lib/equivalence.js /tmp/a.py /tmp/d.py; echo "exit=$?"

# JS (ESM) — body cleanup, same signatures -> "signature-match", recommend_tests:true
printf 'export function add(a,b){\n  // x\n  return a+b;\n}\n' > /tmp/a.js
printf 'export function add(a,b){ return a+b; }\n'             > /tmp/b.js
node lib/equivalence.js /tmp/a.js /tmp/b.js

# JS — broken syntax or changed arity -> "DIFFERENT" + `regressed.` + exit 1
```

Expected verdict ladder: `identical` > `modulo-renames` > `signature-match` >
`body-changed` > `unknown` > `DIFFERENT`. `body-changed` (RANK 1.5) is a SOFT
signal — signatures + behavior-leaves match but the body structure differs in a
way no leaf delta explained. It sets `recommend_tests:true`, exits 0, and is NOT
auto-reverted; consumers treat it as INCONCLUSIVE (keep the edit, but a test-suite
run is mandatory). A hard regression (failed syntax gate OR export/signature
mismatch OR a behavior-leaf delta) emits the literal sentinel `regressed.` on
stdout after the JSON and exits non-zero, so an orchestrating agent can detect it
with a plain string match.

**Non-obvious JS gate detail:** `node:vm` `Script` parses as a *classic* script
and rejects top-level ESM `import`/`export`. `equivalence.js` neutralizes
statement-position module keywords (line-anchored) before the parse so ESM files
still pass the syntax gate while genuine body-level `SyntaxError`s are still
caught. If you change that neutralizer, re-run the ESM cases above.

**`lib/weigh.js`** — run it on a known small file and confirm the component
counts against a manual tally. The **JS path must be verified against hand-counts**
because it is an approximation; do not assume the regex is exact.

### The real proof is the user's test suite

Static checks here are **change-magnitude and structural signals**, not behavioral
guarantees. `equivalence.js` is the GATE that blocks obvious regressions; the
weight number is the SIGNAL that says how much changed. Neither proves runtime
equivalence. Every skill and agent must tell the user: **run your own test suite
— it is the only true behavioral proof.**
