<div align="center">

# addlightness

AI code fat trim for Claude Code and Grok — measure weight, trim, verify equivalence, and benchmark the speedup.

[![plugin-validate](https://github.com/88plug/addlightness/actions/workflows/plugin-validate.yml/badge.svg)](https://github.com/88plug/addlightness/actions/workflows/plugin-validate.yml)
[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue?style=flat)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-online-blue?style=flat)](https://88plug.github.io/addlightness/)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2?style=flat)](https://github.com/88plug/claude-code-plugins)
[![DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/88plug/addlightness)

</div>

> "Simplify, then add lightness." — Colin Chapman, Lotus

addlightness is a zero-dependency Claude Code plugin for developers who ship LLM-written code and want leaner output. It removes AI-generated code fat — speculative abstractions, dead branches, redundant control flow — while preserving behavior, then performance-benchmarks the change with a statistical gate.

Use it to cut technical debt and raise code quality on AI-assisted refactors. Multi-pass pipeline: measure weight → trim → verify equivalence → benchmark.

## Install

### Claude Code

```text
/plugin marketplace add 88plug/claude-code-plugins
/plugin install addlightness@88plug
```

### Grok Build

```text
grok plugin marketplace add 88plug/claude-code-plugins
grok plugin install addlightness@88plug --trust
```


Then run `./install.sh` from the plugin root. It chmods hooks, lib, and benchmark scripts; checks for Node (required) and python3 (optional, for accurate `.py` metrics); and smoke-tests `weigh.js`.

## Quickstart

Point it at a bloated file:

```text
/addlightness src/foo.js
```

You get a before/after weight table and a verified, benchmarked result:

```text
src/foo.js
  metric        before   after
  weight         142.0    78.5   (-44.7%)
  LOC               61      38
  cyclomatic        14       7
  nesting            5       3
  imports            9       5
verify:  signature-match (syntax + export/signature parity held)
bench:   1.42x faster (mean 8.1ms -> 5.7ms, t=4.3, significant)
```

Every edit is gated by an equivalence check before it is reported. Every speedup claim is gated by a Welch significance test. Nothing ships unless it passes both.

> [!NOTE]
> Small files often benchmark as "not significant" — runtime is noise-dominated and the Welch gate refuses to claim a win it cannot prove. See [FAQ](#troubleshooting--faq).

## Features

| Piece | What it does |
| --- | --- |
| `/addlightness <file>` | Full pipeline: measure weight, trim fat, verify equivalence, benchmark |
| `/addlightness-review <file>` | Read-only weight report and fat-candidate list — no edits |
| `/addlightness-bench <before> <after>` | Times before/after commands; reports % improvement with significance |
| `weight-analyst` agent | Read-only metrics + fat-candidate report |
| `code-trimmer` agent | Edit-capable trimmer bounded by trust-boundary + equivalence gate |
| SessionStart + Stop hooks | Announce on start; gently suggest `/addlightness` on files you changed |

## How it works

```mermaid
flowchart LR
  A[measure weight] --> B[trim fat<br/>3 passes]
  B --> C{verify<br/>equivalence}
  C -->|equivalent| D[benchmark]
  C -->|regressed| E[revert + report]
  D --> F[report before/after<br/>+ significance]
```

Trimming runs in three ordered passes so cheap mechanical cleanup happens before judgment work:

1. **Mechanical** — unused imports/vars, no-else-return, useless catch/return, redundant boolean compares. Lint-autofixable, zero judgment.
2. **Semantic** — inline single-use wrappers, collapse redundant control flow, drop only *proven-impossible* defensive checks.
3. **Style** — shorten identifiers in narrow private scope, delete comments that merely restate the code. Why-comments stay.

## Weight formula

Weight is a relative before/after metric — lower is lighter. It is not an absolute industry standard.

```text
weight = 1.0*LOC + 2.0*cyclomatic + 1.5*imports + 1.0*functions + 3.0*nesting

% reduction = (before - after) / before * 100
```

Nesting (3.0) and cyclomatic complexity (2.0) are weighted highest because they discriminate fat best. Imports (1.5) penalize speculative-dependency surface. LOC and function count (1.0) are baseline size. The engine also emits a token proxy and the raw component metrics for the full table.

## What it will not do

> [!WARNING]
> addlightness never strips defensive checks on externally-controlled inputs —
> public API parameters, IO, and parsed/network/env/user data are always kept.
> Only internally-produced, type-guaranteed values are candidates for removal.
> This is the #1 regression vector: tests pass with well-formed inputs even
> after validation is wrongly stripped.

> [!NOTE]
> Every trim is verified by `lib/equivalence.js` before being reported, and
> reverted on any regression. Every benchmark claim is gated by a Welch t-test
> against a df-aware two-tailed 95% Welch critical value (emitted as
> `t_crit_95`; ~2.1–2.3 at the default N=10). A change that is not statistically
> faster is reported as not significant, not as a win. Gate on the emitted
> `significant_at_95` bool — never recompute against a fixed 1.96.

The `code-trimmer` agent also hard-refuses a scope of 3 or more files at once, keeps `return await` inside try/catch, never strips `async` without checking call sites, and never blanket-deletes empty catch blocks.

## Requirements

| Tool | Status |
| --- | --- |
| Node.js >= 18 | Required (core weight engine, hooks) |
| python3 | Optional — accurate `.py` metrics via stdlib `ast` |
| hyperfine | Optional — sharper benchmarks; falls back to `date`+`awk` |

Zero npm dependencies. Run `./install.sh` to make scripts executable and smoke-test the weight engine (`lib/weigh.js`).

## Troubleshooting / FAQ

**Why are JavaScript/TypeScript metrics "approximate"?**
With zero npm dependencies there is no JS parser available, so JS/TS metrics are regex-on-stripped-source approximations (comments, strings, and templates are stripped first). Python metrics use the stdlib `ast` module and are accurate.

**Why was my speedup flagged "not significant"?**
The benchmark gate requires statistical significance. If the Welch `|t|` does not exceed the df-aware two-tailed 95% critical value (`t_crit_95`, ~2.1–2.3 at the default N=10), the change is reported as not significant rather than claimed as faster — even if the mean moved. The verdict is the emitted `significant_at_95` bool; do not recompute it against a fixed 1.96.

**Does static equivalence prove my code still works?**
No. The static ladder (syntax gate, structural/AST diff for Python, signature and export parity for JS) is a change-magnitude and structural signal, not a behavioral guarantee. Your own test suite is the only true runtime-equivalence proof — run it after a trim.

## Development

Local clone (not the primary install path):

```bash
git clone https://github.com/88plug/addlightness.git
cd addlightness
./install.sh
```

Enable the plugin from its local path via Claude Code's `/plugin` command, or add it under `enabledPlugins` in `~/.claude/settings.json` once the marketplace is resolvable (`"<plugin>@<marketplace>"` form).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Maintainer notes live in [CLAUDE.md](CLAUDE.md). Docs: [88plug.github.io/addlightness](https://88plug.github.io/addlightness/).

## License

[FSL-1.1-ALv2](LICENSE).
