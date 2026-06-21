# Changelog

Calendar versioning (`YYYY.M.D`). Most recent first.

## 2026.6.21

- First public release as an 88plug Claude Code plugin.
- Weight engine (`lib/weigh.js`): zero-dep metrics — Python via stdlib `ast` (accurate), JS/TS via regex-on-stripped-source (approximation). JS-metric error driven to 0% vs hand-counted ground truth across the sample set (class-body nesting, TS return-type braces, template-literal interpolation all counted).
- Equivalence gate (`lib/equivalence.js`): node:vm syntax gate + structural/signature parity, plus a body behavior-leaf detector (literal/operator/await/default multiset diff) that catches body-only behavior changes signatures alone miss. Emits `regressed.` sentinel + non-zero exit on regression.
- Benchmark harness (`scripts/benchmark.sh`): Welch-gated significance; reports "not significant" rather than claiming an unproven speedup.
- Three skills (`/addlightness`, `/addlightness-review`, `/addlightness-bench`), two agents (`weight-analyst` read-only, `code-trimmer` edit-capable), SessionStart + Stop hooks.
- CI: structure validation + smoke suite; MkDocs Material docs site to GitHub Pages.
- Hardened over a falsification-first campaign (see `EXPERIMENTS.md`): 3 rounds, ~70 hypotheses, criticals and gate false-negatives fixed and independently re-verified.
