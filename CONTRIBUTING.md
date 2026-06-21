# Contributing to addlightness

Thanks for your interest in improving addlightness. This is a zero-dependency
Claude Code plugin, and contributions should keep it that way.

## Before you start

Read [CLAUDE.md](CLAUDE.md) first. It is the architecture, the design contract,
and the list of non-obvious traps. The hard constraints there are not
preferences — breaking one is a regression:

- Zero npm dependencies, everywhere. Node stdlib only.
- Every trim is gated by `lib/equivalence.js` before being reported as success.
- Every benchmark claim is gated by Welch-style significance.
- Never strip defensive checks on externally-controlled inputs.

## Development

There is no test runner (zero-dep constraint). Verify by running the engines
directly against `/tmp` samples and checking the output against hand counts. See
CLAUDE.md section 8 for the exact smoke-test commands for both `lib/weigh.js` and
`lib/equivalence.js`.

Run `./install.sh` to make the scripts executable and smoke-test the weight
engine.

## Pull requests

- Keep changes scoped. Don't bundle drive-by refactors with a fix.
- Update CLAUDE.md and README.md if you change the weight formula, add a metric,
  or add a skill/agent.
- Keep the JS path honest: JS/TS metrics are regex approximations, not AST. Never
  claim AST precision for the JS path.
