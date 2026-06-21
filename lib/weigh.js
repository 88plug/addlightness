#!/usr/bin/env node
'use strict';

/*
 * lib/weigh.js — zero-dependency code "weight" engine.
 *
 * Computes a single scalar weight plus its raw component metrics for one source
 * file, so callers can render a before/after table and a % reduction. The weight
 * is a RELATIVE before/after comparison metric (lower = lighter), NOT an absolute
 * industry standard — do not present it as one.
 *
 *   weight = 1.0*loc + 2.0*cyclomatic + 1.5*imports + 1.0*functions + 3.0*nesting
 *
 * JS/TS path: a char-state lexer strips comments, template literals, and quoted
 * strings (newline-preserving, so line counts stay correct) before counting.
 * Every JS/TS metric is regex-approximate and flagged approx:true.
 *
 * Python path: spawns python3 with a stdlib `ast` snippet — flagged approx:false
 * (ast-accurate). If python3 is missing or the source won't parse, it falls back
 * to a regex estimator and sets approx:true.
 *
 * Usage:
 *   node lib/weigh.js <file> [--json]
 *
 * Library:
 *   const { measure, computeWeight, WEIGHT_FORMULA, COEFF } = require('./weigh');
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PY_EXTS = new Set(['.py', '.pyi']);
const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

const COEFF = Object.freeze({
  loc: 1.0,
  cyclomatic: 2.0,
  imports: 1.5,
  functions: 1.0,
  nesting: 3.0,
});

const WEIGHT_FORMULA =
  '1.0*loc + 2.0*cyclomatic + 1.5*imports + 1.0*functions + 3.0*nesting';

function computeWeight(m) {
  const w =
    COEFF.loc * m.loc +
    COEFF.cyclomatic * m.cyclomatic +
    COEFF.imports * m.imports +
    COEFF.functions * m.functions +
    COEFF.nesting * m.nesting;
  return Math.round(w * 100) / 100;
}

/* ---------- JS/TS path ---------- */

// Strip block comments, line comments, template literals, and quoted strings,
// replacing their contents with spaces but PRESERVING newlines so line counts
// and per-line analysis stay accurate.
// True when a `/` at the current position begins a regex literal rather than a
// division operator. Standard heuristic: look back at the last significant
// (non-space, non-comment) char already emitted; a regex can only start in
// expression position, i.e. after an operator / opening bracket / comma /
// semicolon / a keyword like `return`. After a value (identifier, number, `)`,
// `]`) a `/` is division.
function regexAllowedAfter(out) {
  let j = out.length - 1;
  while (j >= 0 && (out[j] === ' ' || out[j] === '\n' || out[j] === '\t')) j -= 1;
  if (j < 0) return true; // start of input -> expression position
  const prev = out[j];
  if ('([{,;:=!&|?+-*%^~<>'.includes(prev)) return true;
  // Word char: regex is allowed only after a keyword (return, typeof, case, etc.)
  if (/[\w$]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[\w$]/.test(out[k])) k -= 1;
    const word = out.slice(k + 1, j + 1);
    const KW = new Set([
      'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
      'do', 'else', 'yield', 'await', 'case', 'throw',
    ]);
    return KW.has(word);
  }
  return false;
}

function stripJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // states: code, line-comment, block-comment, sq (' '), dq (" "), tpl (` `),
  // regex (/.../ literal)
  let state = 'code';
  // Template-literal interpolation `${ ... }` carries real code (arrows,
  // ternaries, calls) that the metrics must see. We KEEP that code instead of
  // blanking it: on `${` we re-enter `code` and push a frame recording (a) the
  // template state to resume and (b) a brace counter so an object-literal `{`
  // inside the interpolation isn't mistaken for the closing `}`. Nested
  // templates push further frames. The backtick text itself stays blanked.
  const tplStack = []; // [{ braceDepth }] — one frame per open interpolation
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '{' && tplStack.length > 0) {
        tplStack[tplStack.length - 1].braceDepth += 1;
        out += c;
        i += 1;
      } else if (c === '}' && tplStack.length > 0
                 && tplStack[tplStack.length - 1].braceDepth === 0) {
        // close of the current interpolation -> back into the template string
        tplStack.pop();
        state = 'tpl';
        out += ' ';
        i += 1;
      } else if (c === '}' && tplStack.length > 0) {
        tplStack[tplStack.length - 1].braceDepth -= 1;
        out += c;
        i += 1;
      } else if (c === '/' && c2 === '/') {
        state = 'line';
        out += '  ';
        i += 2;
      } else if (c === '/' && c2 === '*') {
        state = 'block';
        out += '  ';
        i += 2;
      } else if (c === '/' && regexAllowedAfter(out)) {
        // regex literal start
        state = 'regex';
        out += ' ';
        i += 1;
      } else if (c === "'") {
        state = 'sq';
        out += ' ';
        i += 1;
      } else if (c === '"') {
        state = 'dq';
        out += ' ';
        i += 1;
      } else if (c === '`') {
        state = 'tpl';
        out += ' ';
        i += 1;
      } else {
        out += c;
        i += 1;
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += '\n';
        i += 1;
      } else {
        out += ' ';
        i += 1;
      }
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        out += '  ';
        i += 2;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
    } else if (state === 'regex') {
      if (c === '\\') {
        out += ' ';
        out += src[i + 1] === '\n' ? '\n' : ' ';
        i += 2;
      } else if (c === '[') {
        // enter char-class: a `/` inside [...] does not close the regex
        state = 'regex-class';
        out += ' ';
        i += 1;
      } else if (c === '/') {
        state = 'code';
        out += ' ';
        i += 1;
      } else if (c === '\n') {
        // unterminated regex (shouldn't happen for valid src) — bail to code
        state = 'code';
        out += '\n';
        i += 1;
      } else {
        out += ' ';
        i += 1;
      }
    } else if (state === 'regex-class') {
      if (c === '\\') {
        out += ' ';
        out += src[i + 1] === '\n' ? '\n' : ' ';
        i += 2;
      } else if (c === ']') {
        state = 'regex';
        out += ' ';
        i += 1;
      } else if (c === '\n') {
        state = 'code';
        out += '\n';
        i += 1;
      } else {
        out += ' ';
        i += 1;
      }
    } else if (state === 'tpl') {
      if (c === '\\') {
        out += ' ';
        out += src[i + 1] === '\n' ? '\n' : ' ';
        i += 2;
      } else if (c === '$' && c2 === '{') {
        // enter interpolation: keep its code, blank the `${`
        tplStack.push({ braceDepth: 0 });
        state = 'code';
        out += '  ';
        i += 2;
      } else if (c === '`') {
        state = 'code';
        out += ' ';
        i += 1;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
    } else if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"';
      if (c === '\\') {
        // skip escaped char, preserve newline shape
        out += ' ';
        out += src[i + 1] === '\n' ? '\n' : ' ';
        i += 2;
      } else if (c === quote) {
        state = 'code';
        out += ' ';
        i += 1;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
    }
  }
  return out;
}

function countMatches(s, re) {
  const m = s.match(re);
  return m ? m.length : 0;
}

function measureJs(src, lang) {
  // Drop a leading shebang (preserving the newline so line numbers are stable)
  // so an executable script's `#!` line isn't counted as a line of code.
  if (src.startsWith('#!')) src = src.replace(/^#!.*\n?/, '\n');
  let stripped = stripJs(src);
  const isTs = lang === 'typescript';
  if (isTs) {
    // TS optional member/param `name?:` reads as `?...:` and would be miscounted
    // as a ternary. Neutralize the `?` of an identifier immediately followed by
    // `?:` before decision counting (preserve length to keep offsets stable).
    stripped = stripped.replace(/([A-Za-z_$][\w$]*)(\?)(\s*:)/g, '$1 $3');
  }

  // LOC — non-blank lines of stripped source (comments already removed).
  const loc = stripped.split('\n').filter((l) => l.trim().length > 0).length;

  // cyclomatic = 1 + decision points.
  let decisions = 0;
  decisions += countMatches(stripped, /\bif\b/g);
  decisions += countMatches(stripped, /\bfor\b/g);
  decisions += countMatches(stripped, /\bwhile\b/g);
  decisions += countMatches(stripped, /\bcase\b/g);
  // catch CLAUSE only — exclude `.catch(` promise method calls.
  decisions += countMatches(stripped, /(?<!\.)\bcatch\b/g);
  decisions += countMatches(stripped, /&&/g);
  decisions += countMatches(stripped, /\|\|/g);
  decisions += countMatches(stripped, /\?\?/g);
  // ternary: a "?" that is NOT part of ?. or ?? (those are handled / excluded).
  // The leading lookbehind also excludes the SECOND "?" of "??" so nullish
  // coalescing isn't double-counted (once here and once by the /\?\?/g above).
  decisions += countMatches(stripped, /(?<!\?)\?(?![.?])/g);
  const cyclomatic = 1 + decisions;

  // imports = static import statements + require() + dynamic import() calls.
  // TS `import type {...}` is erased at compile time (zero runtime surface) and
  // is excluded via the `(?!\s+type\b)` lookahead. A statement-position `import`
  // directly followed by `(` is a dynamic-import CALL — already counted by
  // dynamicImports below — so `(?!\s*\()` keeps it from being double-counted.
  const importStmts = countMatches(stripped, /(^|\n)\s*import\b(?!\s+type\b)(?!\s*\()/g);
  const requires = countMatches(stripped, /\brequire\s*\(/g);
  const dynamicImports = countMatches(stripped, /\bimport\s*\(/g);
  const imports = importStmts + requires + dynamicImports;

  // functions = function keyword + class + arrow + method shorthand (approx).
  let functions = 0;
  functions += countMatches(stripped, /\bfunction\b/g);
  functions += countMatches(stripped, /\bclass\b/g);
  functions += countMatches(stripped, /=>/g);
  // Method shorthand: `name(params) {` at statement/member position (class
  // methods, object methods). Exclude control-flow headers and the `function`
  // keyword so they aren't double-counted.
  const NON_METHOD = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do',
    'else', 'with', 'typeof', 'await', 'yield', 'in', 'of', 'new', 'void',
    'delete', 'throw', 'case',
  ]);
  const methodRe =
    /(^|[\n;{}(,:])\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let mm;
  while ((mm = methodRe.exec(stripped)) !== null) {
    if (!NON_METHOD.has(mm[2])) functions += 1;
  }

  // nesting = max CONTROL/FUNCTION brace depth (approx). A naive max-brace-depth
  // over-reports on object-literal/destructuring/JSX-expression braces, which are
  // pervasive and would dominate the heaviest-weighted (3.0) dimension. Cheap
  // zero-dep mitigation: a `{` only opens a counted block when it is in
  // control/function position — i.e. the last significant char before it is `)`
  // (an `if(...) {`, `for(...) {`, `function(...) {`, arrow `=> {` is handled via
  // the `>` case) or a control/function keyword. Braces immediately following
  // `=`, `(`, `,`, `:`, `[`, or `return`/`=>` are object-literal/JSX/expression
  // braces and are NOT counted as nesting. Every `{` still pushes the depth stack
  // (so matching `}` stays balanced); only counted braces raise maxDepth.
  // This stays an approximation — JS nesting is the least-precise JS metric.
  const CTRL_KW = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally',
    'function', 'class',
  ]);
  function lastWordBefore(s, idx) {
    let k = idx;
    while (k >= 0 && /[\w$]/.test(s[k])) k -= 1;
    return s.slice(k + 1, idx + 1);
  }
  // Two header shapes put a word/`>` (not `)` or a control keyword) right
  // before a block-opening brace, so the simple checks miss them:
  //   1. `class Name<T> extends Base implements I {` — the class name/clause.
  //   2. `fn(args): ReturnType {` — a TS return-type annotation after `)`.
  // Walk left across the header span (identifiers, `.`, `,`, `:`, `[]`, `|`,
  // `<>` generics, whitespace) until a hard boundary. If the span contains the
  // `class` keyword it's a class body; if the scan reaches a `)` it's a
  // return-type-annotated function/method body. Bounded scan; zero-dep approx.
  function classifyWordBrace(s, idx) {
    let k = idx;
    let angle = 0;
    while (k >= 0) {
      const ch = s[k];
      if (ch === '>') { angle += 1; k -= 1; continue; }
      if (ch === '<') { if (angle > 0) angle -= 1; k -= 1; continue; }
      if (angle > 0) { k -= 1; continue; }
      if (ch === ')') {
        // function/method return-type annotation: `): Type {`
        const span = s.slice(k + 1, idx + 1);
        if (/^[\s:]/.test(span)) return 'block';
        break;
      }
      if (/[\w$.,:|[\]\s]/.test(ch)) { k -= 1; continue; }
      break; // hard boundary: ; { } = ( etc.
    }
    const span = s.slice(k + 1, idx + 1);
    if (/(^|[^\w$])class[^\w$]/.test(span)) return 'block';
    return 'expr';
  }
  // `ctrlDepth` counts only control/function braces; `maxDepth` is its peak.
  // A `counted` stack runs parallel to ALL open braces so each `}` knows whether
  // its matching `{` was a counted (control) brace and adjusts `ctrlDepth`.
  let ctrlDepth = 0;
  let maxDepth = 0;
  const counted = []; // parallel stack: was this open-brace a control brace?
  for (let p = 0; p < stripped.length; p += 1) {
    const ch = stripped[p];
    if (ch === '{') {
      // find last significant (non-space) char before this brace
      let j = p - 1;
      while (j >= 0 && (stripped[j] === ' ' || stripped[j] === '\n' || stripped[j] === '\t')) j -= 1;
      const prev = j >= 0 ? stripped[j] : '';
      let isBlock = false;
      if (prev === ')') {
        isBlock = true; // if/for/while/switch/catch/function(...) header, etc.
      } else if (prev === '>' && j >= 1 && stripped[j - 1] === '=') {
        isBlock = true; // arrow function body `=> {`
      } else if (prev === '>') {
        // `class Foo<T> {` or `fn(): Promise<T> {` — generics close before brace.
        if (classifyWordBrace(stripped, j) === 'block') isBlock = true;
      } else if (/[\w$]/.test(prev)) {
        const word = lastWordBefore(stripped, j);
        // `do {`, `else {`, `try {`, `finally {` — keyword directly before brace
        if (CTRL_KW.has(word)) isBlock = true;
        // `class Name {`, `class X extends Y {`, or `fn(): Type {` — name/type
        // precedes the brace rather than `)` or a control keyword.
        else if (classifyWordBrace(stripped, j) === 'block') isBlock = true;
      }
      counted.push(isBlock);
      if (isBlock) {
        ctrlDepth += 1;
        if (ctrlDepth > maxDepth) maxDepth = ctrlDepth;
      }
    } else if (ch === '}') {
      if (counted.length > 0) {
        const wasBlock = counted.pop();
        if (wasBlock && ctrlDepth > 0) ctrlDepth -= 1;
      }
    }
  }
  const nesting = maxDepth;

  const tokens = stripped.split(/\s+/).filter(Boolean).length;

  const metrics = { loc, cyclomatic, imports, functions, nesting };
  return {
    lang,
    ...metrics,
    tokens,
    weight: computeWeight(metrics),
    approx: true,
    weight_formula: WEIGHT_FORMULA,
  };
}

/* ---------- Python path ---------- */

// Stdlib-only ast snippet. Reads the file given as argv[1], prints json.dumps.
const PY_SRC = `
import ast, json, sys, tokenize, io

src = open(sys.argv[1], 'r', encoding='utf-8').read()
tree = ast.parse(src)

# loc: count physical lines that carry a real (non-comment, non-layout) token.
# Using tokenize makes a hash-leading line INSIDE a string count as code and a
# genuine hash comment line not count -- ast/tokenize-accurate, unlike a naive
# line scan that cannot tell the two apart.
_SKIP = frozenset((
    tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE,
    tokenize.INDENT, tokenize.DEDENT, tokenize.ENCODING, tokenize.ENDMARKER,
))
try:
    code_lines = set()
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type in _SKIP:
            continue
        if tok.type == tokenize.STRING or tok.type == getattr(tokenize, 'FSTRING_START', -1):
            # a (possibly multi-line) string occupies every physical line it spans
            for ln in range(tok.start[0], tok.end[0] + 1):
                code_lines.add(ln)
        else:
            code_lines.add(tok.start[0])
    loc = len(code_lines)
except (tokenize.TokenError, IndentationError):
    # fall back to the naive scan if tokenize chokes on the source
    loc = 0
    for line in src.splitlines():
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        loc += 1

DECISION = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler,
            ast.With, ast.AsyncWith, ast.comprehension, ast.IfExp)
try:
    DECISION = DECISION + (ast.match_case,)
except AttributeError:
    pass

decisions = 0
imports = 0
functions = 0
for node in ast.walk(tree):
    if isinstance(node, DECISION):
        decisions += 1
    elif isinstance(node, ast.BoolOp):
        decisions += len(node.values) - 1
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        imports += len(node.names)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        functions += 1

cyclomatic = 1 + decisions

BLOCK = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.If, ast.For,
         ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Try,
         ast.ExceptHandler)

def depth(node, d=0):
    best = d
    for child in ast.iter_child_nodes(node):
        nd = d + 1 if isinstance(child, BLOCK) else d
        best = max(best, depth(child, nd))
    return best

nesting = depth(tree)
tokens = len(src.split())

print(json.dumps({
    'loc': loc,
    'cyclomatic': cyclomatic,
    'imports': imports,
    'functions': functions,
    'nesting': nesting,
    'tokens': tokens,
}))
`;

// Regex fallback when python3 is missing or the source won't parse.
function measurePyRegex(src) {
  const lines = src.split('\n');
  const code = lines.filter((l) => {
    const s = l.trim();
    return s.length > 0 && !s.startsWith('#');
  });
  const loc = code.length;
  const joined = code.join('\n');

  let decisions = 0;
  decisions += countMatches(joined, /(^|\s)if\b/g);
  decisions += countMatches(joined, /(^|\s)elif\b/g);
  decisions += countMatches(joined, /(^|\s)for\b/g);
  decisions += countMatches(joined, /(^|\s)while\b/g);
  decisions += countMatches(joined, /(^|\s)except\b/g);
  decisions += countMatches(joined, /(^|\s)with\b/g);
  decisions += countMatches(joined, /(^|\s)and\b/g);
  decisions += countMatches(joined, /(^|\s)or\b/g);
  const cyclomatic = 1 + decisions;

  const imports =
    countMatches(joined, /(^|\n)\s*import\b/g) +
    countMatches(joined, /(^|\n)\s*from\b\s+\S+\s+import\b/g);

  const functions =
    countMatches(joined, /(^|\n)\s*(async\s+)?def\b/g) +
    countMatches(joined, /(^|\n)\s*class\b/g);

  // nesting via indentation: max indent / minimum-step heuristic.
  let maxIndent = 0;
  for (const l of code) {
    if (!l.trim()) continue;
    const indent = l.length - l.replace(/^\s+/, '').length;
    if (indent > maxIndent) maxIndent = indent;
  }
  const nesting = Math.round(maxIndent / 4);

  const tokens = joined.split(/\s+/).filter(Boolean).length;

  const metrics = { loc, cyclomatic, imports, functions, nesting };
  return {
    ...metrics,
    tokens,
    weight: computeWeight(metrics),
    approx: true,
  };
}

function measurePy(file, src) {
  const py = process.env.PYTHON || 'python3';
  const res = spawnSync(py, ['-c', PY_SRC, file], { encoding: 'utf8' });
  if (res.error || res.status !== 0 || !res.stdout) {
    const fb = measurePyRegex(src);
    return {
      lang: 'python',
      ...fb,
      weight_formula: WEIGHT_FORMULA,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch (e) {
    const fb = measurePyRegex(src);
    return {
      lang: 'python',
      ...fb,
      weight_formula: WEIGHT_FORMULA,
    };
  }
  const metrics = {
    loc: parsed.loc,
    cyclomatic: parsed.cyclomatic,
    imports: parsed.imports,
    functions: parsed.functions,
    nesting: parsed.nesting,
  };
  return {
    lang: 'python',
    ...metrics,
    tokens: parsed.tokens,
    weight: computeWeight(metrics),
    approx: false,
    weight_formula: WEIGHT_FORMULA,
  };
}

/* ---------- dispatch ---------- */

function measure(file) {
  const ext = path.extname(file).toLowerCase();
  const src = fs.readFileSync(file, 'utf8');
  let result;
  if (PY_EXTS.has(ext)) {
    result = measurePy(file, src);
  } else if (JS_EXTS.has(ext)) {
    const lang = ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts'
      ? 'typescript'
      : 'javascript';
    result = measureJs(src, lang);
  } else {
    // Unknown extension: treat as JS-ish so callers still get numbers.
    result = measureJs(src, 'unknown');
  }
  return { file, ...result };
}

/* ---------- CLI ---------- */

function usage() {
  process.stderr.write('usage: node lib/weigh.js <file> [--json]\n');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) usage();

  let result;
  try {
    result = measure(file);
  } catch (e) {
    process.stderr.write(`weigh: ${e.message}\n`);
    process.exit(1);
  }

  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }

  const tag = result.approx ? ' (approx)' : ' (ast-accurate)';
  const rows = [
    ['file', result.file],
    ['lang', result.lang + tag],
    ['loc', result.loc],
    ['cyclomatic', result.cyclomatic],
    ['imports', result.imports],
    ['functions', result.functions],
    ['nesting', result.nesting],
    ['tokens', result.tokens],
    ['weight', result.weight],
  ];
  const w = Math.max(...rows.map((r) => String(r[0]).length));
  for (const [k, v] of rows) {
    process.stdout.write(`${String(k).padEnd(w)}  ${v}\n`);
  }
  process.stdout.write(`formula  ${WEIGHT_FORMULA}\n`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { measure, computeWeight, WEIGHT_FORMULA, COEFF };
