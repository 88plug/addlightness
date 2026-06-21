#!/usr/bin/env node
'use strict';

/*
 * equivalence.js — zero-dependency functional-equivalence GATE for addlightness.
 *
 * Usage:  node lib/equivalence.js <before> <after>
 *
 * Purpose
 * -------
 * weigh.js produces a change-MAGNITUDE signal (a weight number). This file is a
 * different thing: the safety GATE. Before a trim is reported as success, the
 * "before" and "after" sources are run through a verification ladder, cheapest
 * check first, strongest last. If the strongest available check says the change
 * is more than cosmetic/rename, we do NOT silently bless it — we surface that and
 * recommend the only thing that actually proves runtime equivalence: the user's
 * own test suite.
 *
 * Honesty about limits (read this before trusting the output)
 * -----------------------------------------------------------
 * - There is NO npm dependency anywhere (no acorn/babel/typescript). The machine
 *   has none, and that is a hard project constraint.
 * - JS/TS has no built-in AST. The honest zero-dep gate we CAN do is a syntax
 *   parse via node:vm Script (it PARSES without executing) plus a regex-based
 *   export/signature parity check over stripped source. That parity check is a
 *   weak heuristic, not a proof.
 * - Python is parsed with the stdlib `ast` module (spawned python3). That path
 *   is accurate: we can do an exact structural diff and a rename-insensitive
 *   (alpha-normalized) diff.
 * - NOTHING here proves runtime/behavioral equivalence. Static analysis is a
 *   gate that catches obvious regressions (syntax breakage, dropped/renamed
 *   exports, changed arities, structurally different control flow). The user's
 *   existing test suite is the only true behavioral proof, so we recommend it.
 *
 * Output (single JSON object on stdout)
 * -------------------------------------
 * {
 *   equivalent: 'identical'|'modulo-renames'|'signature-match'|'unknown'|'DIFFERENT',
 *   syntax_ok:  boolean,        // both files parsed
 *   exports_match: boolean,     // export/signature parity held
 *   notes: [ ...strings ],
 *   recommend_tests: boolean
 * }
 *
 * On a HARD regression (syntax break, or export/signature mismatch) the JSON is
 * still emitted, and the literal terminal token `regressed.` is written to stdout
 * AFTER the JSON so an orchestrating agent can detect failure deterministically
 * with a simple string match. Process exit code is also non-zero in that case.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const PY_EXTS = new Set(['.py', '.pyi']);
const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

function fail(msg) {
  process.stderr.write(`equivalence: ${msg}\n`);
  process.exit(2);
}

function readFileOr(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`cannot read ${file}: ${e.message}`);
  }
}

/* ---------------------------------------------------------------- shared --- */

// Verdict ordering, strongest to weakest, for picking the best label.
const RANK = {
  identical: 4,
  'modulo-renames': 3,
  'signature-match': 2,
  'body-changed': 1.5,
  unknown: 1,
  DIFFERENT: 0,
};

function emit(result) {
  // A hard fail is a PROVEN regression: a real syntax break or an export/
  // signature mismatch. An 'unknown' verdict (e.g. a file the zero-dep gate
  // cannot parse: TS/JSX, or an unsupported extension) is NOT a regression and
  // must never emit the sentinel or a non-zero exit.
  const hardFail =
    result.equivalent === 'DIFFERENT' ||
    (result.equivalent !== 'unknown' && (!result.syntax_ok || !result.exports_match));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (hardFail) {
    // Deterministic sentinel for orchestrating agents to grep.
    process.stdout.write('regressed.\n');
    process.exit(1);
  }
  process.exit(0);
}

/* ------------------------------------------------------------------- JS ---- */

// Strip comments, strings and template literals so structural regexes don't
// trip over string contents. Conservative: when in doubt, blanks the span.
function stripJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && c2 === '/') { state = 'line'; i += 2; }
        else if (c === '/' && c2 === '*') { state = 'block'; i += 2; }
        else if (c === "'") { state = 'sq'; out += ' '; i++; }
        else if (c === '"') { state = 'dq'; out += ' '; i++; }
        else if (c === '`') { state = 'tpl'; out += ' '; i++; }
        else { out += c; i++; }
        break;
      case 'line':
        if (c === '\n') { state = 'code'; out += '\n'; i++; }
        else i++;
        break;
      case 'block':
        if (c === '*' && c2 === '/') { state = 'code'; i += 2; }
        else { if (c === '\n') out += '\n'; i++; }
        break;
      case 'sq':
        if (c === '\\') i += 2;
        else if (c === "'") { state = 'code'; i++; }
        else i++;
        break;
      case 'dq':
        if (c === '\\') i += 2;
        else if (c === '"') { state = 'code'; i++; }
        else i++;
        break;
      case 'tpl':
        // Treat the whole template (incl. ${...}) as opaque. Good enough for
        // export/signature regexes which never live inside templates.
        if (c === '\\') i += 2;
        else if (c === '`') { state = 'code'; i++; }
        else { if (c === '\n') out += '\n'; i++; }
        break;
    }
  }
  return out;
}

// ---- behavior-leaf fingerprinting (body-change detection) -----------------
//
// The export/signature parity check above is blind to function BODIES: it ships
// any edit that keeps export names+arities, even when a literal, operator,
// `await`, or default-param value changed (a real behavior change). These
// helpers add a body-level SIGNAL without an AST and without new deps.
//
// Two distinct strengths are produced:
//   - A multiset of BEHAVIOR-BEARING LEAVES (numeric/string literals, equality/
//     relational/arithmetic operators, await/yield, regex bodies, default param
//     values). A delta here is a genuine behavior change -> hard 'DIFFERENT'.
//   - A rename-canonicalized whole-body TOKEN VECTOR. A delta here that the leaf
//     multiset did NOT explain is a weaker structural signal -> 'body-changed'
//     (recommend_tests, but NOT a hard fail / no auto-revert).
//
// Everything is computed over stripJs() output (rename/comment-insensitive) EXCEPT
// the string-literal pass, which must read raw source because stripJs blanks
// strings. The operator pass uses stripped source so operators inside strings
// never count.

// Fixed JS keyword set so identifier canonicalization never renames a keyword.
const JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await',
  'async', 'of', 'as', 'from', 'get', 'set', 'null', 'true', 'false', 'undefined',
]);

// Extract STRING and NUMERIC literal contents from RAW source, using the same
// state machine as stripJs but EMITTING the literal text instead of blanking it.
// Numeric literals are collected from code-state spans. Returns sorted multisets.
function extractJsLiterals(src) {
  const strings = [];
  let codeBuf = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  let cur = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && c2 === '/') { state = 'line'; i += 2; }
        else if (c === '/' && c2 === '*') { state = 'block'; i += 2; }
        else if (c === "'") { state = 'sq'; cur = ''; i++; }
        else if (c === '"') { state = 'dq'; cur = ''; i++; }
        else if (c === '`') { state = 'tpl'; cur = ''; i++; }
        else { codeBuf += c; i++; }
        break;
      case 'line':
        if (c === '\n') { state = 'code'; i++; } else i++;
        break;
      case 'block':
        if (c === '*' && c2 === '/') { state = 'code'; i += 2; } else i++;
        break;
      case 'sq':
        if (c === '\\') { cur += src[i] + (src[i + 1] || ''); i += 2; }
        else if (c === "'") { strings.push('s:' + cur); state = 'code'; i++; }
        else { cur += c; i++; }
        break;
      case 'dq':
        if (c === '\\') { cur += src[i] + (src[i + 1] || ''); i += 2; }
        else if (c === '"') { strings.push('s:' + cur); state = 'code'; i++; }
        else { cur += c; i++; }
        break;
      case 'tpl':
        if (c === '\\') { cur += src[i] + (src[i + 1] || ''); i += 2; }
        else if (c === '`') { strings.push('t:' + cur); state = 'code'; i++; }
        else { cur += c; i++; }
        break;
    }
  }
  const numbers = [];
  const reNum = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?\d*|\.\d[\d_]*)(?:[eE][+-]?\d+)?/g;
  let m;
  while ((m = reNum.exec(codeBuf))) numbers.push(m[0].replace(/_/g, ''));
  strings.sort();
  numbers.sort();
  return { strings, numbers };
}

// Build a counted multiset of behavior-bearing OPERATOR / keyword leaves over
// STRIPPED source (so operators inside strings don't count). Longest operators
// first so '===' is not misread as two '=='.
function jsOperatorMultiset(stripped) {
  const counts = {};
  const bump = (k, by) => { counts[k] = (counts[k] || 0) + (by || 1); };
  // Longest-first multi-char operators.
  const reOps = />>>=|===|!==|\*\*=|<<=|>>=|>>>|&&=|\|\|=|\?\?=|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\*\*|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|=>/g;
  let s = stripped;
  let m;
  while ((m = reOps.exec(s))) bump(m[0]);
  // Single-char arithmetic / comparison / bitwise operators left after removing
  // the multi-char ones (so + in ++ isn't double counted).
  const singles = s.replace(reOps, ' ');
  for (const ch of singles) {
    // '!' and '~' are unary; the multi-char '!=' / '!==' were already consumed
    // by reOps, so a remaining '!' is a genuine logical-NOT (behavior-bearing).
    if ('+-*/%<>&|^~!'.includes(ch)) bump(ch);
  }
  // Behavior-bearing keyword operators.
  const reKw = /\b(await|yield|delete|typeof|void|new|instanceof|in)\b/g;
  while ((m = reKw.exec(s))) bump('kw:' + m[1]);
  // Regex-literal bodies: a '/' in operator position whose preceding non-space
  // token suggests a regex context. Heuristic and conservative.
  const reRegex = /(^|[=(,:[!&|?{};]|return|typeof)\s*\/(?![*/])((?:\\.|[^\\\/\n])+)\/[a-z]*/g;
  while ((m = reRegex.exec(s))) bump('re:' + m[2]);
  return counts;
}

// Rename-canonicalized token VECTOR over stripped source: every NON-keyword
// identifier becomes a positional placeholder V0,V1,... so pure renames produce
// an identical vector. Preserves multi-char operators, numbers, punctuation.
function jsCanonTokens(stripped) {
  const reTok =
    />>>=|===|!==|\*\*=|<<=|>>=|>>>|&&=|\|\|=|\?\?=|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\*\*|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|=>|0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?\d*|\.\d[\d_]*)(?:[eE][+-]?\d+)?|[A-Za-z_$][\w$]*|[(){}\[\].,;:?!~+\-*/%<>=&|^]/g;
  const out = [];
  const map = {};
  let m;
  let prev = null;
  while ((m = reTok.exec(stripped))) {
    const t = m[0];
    if (/^[A-Za-z_$][\w$]*$/.test(t) && !JS_KEYWORDS.has(t)) {
      // Property-access position (member name after '.' or '?.') is NOT a binding
      // and must NOT be placeholdered — o.min vs o.max are different behavior.
      // Mirror Python's AlphaNormalizer, which never renames ast.Attribute.attr.
      // Emit the property name literally so the canon vectors differ.
      if (prev === '.' || prev === '?.') {
        out.push('prop:' + t);
      } else {
        if (!(t in map)) map[t] = 'V' + Object.keys(map).length;
        out.push(map[t]);
      }
    } else {
      out.push(t);
    }
    prev = t;
  }
  return out;
}

// Diff two counted multisets -> list of human-readable delta strings (capped).
function multisetDelta(a, b, label) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const deltas = [];
  for (const k of keys) {
    const av = a[k] || 0;
    const bv = b[k] || 0;
    if (av !== bv) deltas.push(`${label} '${k}' x${av} -> x${bv}`);
  }
  return deltas;
}

// Diff two sorted literal arrays (multiset semantics) -> delta strings.
function arrayMultisetDelta(a, b, label) {
  const count = (arr) => arr.reduce((acc, v) => ((acc[v] = (acc[v] || 0) + 1), acc), {});
  return multisetDelta(count(a), count(b), label);
}

// Given stripped source and the index of an opening '(', return the substring
// between it and its balanced matching ')', plus the index just past that ')'.
// Returns null if no balanced match is found. Counts ()[]{} depth so a default
// expression containing parens (e.g. `cb = fn(1, 2)`) does not terminate early.
function scanBalancedParens(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return { params: src.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

// Count top-level comma-separated args in a parameter list (best-effort).
function arity(paramStr) {
  const s = paramStr.trim();
  if (s === '') return 0;
  let depth = 0;
  let count = 1;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

// Extract an exported-name -> arity map from stripped JS source. Heuristic and
// intentionally narrow: named export functions, and CommonJS exports.NAME = .
function extractExports(stripped) {
  const map = {};
  let m;

  // export default function NAME(args) — the binding NAME is internal and not
  // part of the import contract (consumers do `import anything from`). Track it
  // under a fixed sentinel so an internal-name rename isn't seen as removed+added,
  // while a real default-export arity change is still caught.
  const reExportDefaultFn = /export\s+default\s+(?:async\s+)?function\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g;
  while ((m = reExportDefaultFn.exec(stripped))) map['__default__'] = arity(m[1]);

  // export function NAME(args)   /   export async function NAME(args)
  // Anchor on the name + opening '(' only, then scan the balanced param list so
  // a default expression containing parens (e.g. `cb = fn(1, 2)`) is captured in
  // full rather than truncated at the first inner ')'.
  const reExportFn = /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = reExportFn.exec(stripped))) {
    const scan = scanBalancedParens(stripped, reExportFn.lastIndex - 1);
    if (scan) map[m[1]] = arity(scan.params);
  }

  // export const NAME = (args) =>  /  export const NAME = arg =>  /  = function(args)
  // Single-identifier arrow param (`arg =>`) has arity 1; the parenthesized form
  // is scanned with balanced-paren matching to survive paren-bearing defaults.
  const reExportConstArrow = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\(|([A-Za-z_$][\w$]*)\s*=>)/g;
  while ((m = reExportConstArrow.exec(stripped))) {
    if (m[3] !== undefined) {
      map[m[1]] = 1; // single-identifier arrow param
    } else {
      // m[2] === '(' : opening paren is the char before lastIndex.
      const scan = scanBalancedParens(stripped, reExportConstArrow.lastIndex - 1);
      if (scan && /^\s*=>/.test(stripped.slice(scan.end))) map[m[1]] = arity(scan.params);
    }
  }
  const reExportConstFn = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*\(/g;
  while ((m = reExportConstFn.exec(stripped))) {
    const scan = scanBalancedParens(stripped, reExportConstFn.lastIndex - 1);
    if (scan) map[m[1]] = arity(scan.params);
  }

  // export default class [NAME] — internal name, track under the sentinel.
  const reExportDefaultClass = /export\s+default\s+class\b/g;
  while ((m = reExportDefaultClass.exec(stripped))) if (!('__default__' in map)) map['__default__'] = -1;

  // export class NAME
  const reExportClass = /export\s+class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reExportClass.exec(stripped))) if (!(m[1] in map)) map[m[1]] = -1;

  // module.exports.NAME = ...  /  exports.NAME = ...
  // Capture arity when the RHS is a function or arrow form; otherwise -1.
  //   exports.f = function(a,b){...}   -> arity 2
  //   exports.f = (a,b) => ...         -> arity 2
  //   exports.f = a => ...             -> arity 1
  //   exports.f = someValue            -> arity unknown (-1)
  const reCjsNamed = /(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:(?:function\s*\*?\s*\(([^)]*)\))|(?:\(([^)]*)\)\s*=>)|(?:([A-Za-z_$][\w$]*)\s*=>))?/g;
  while ((m = reCjsNamed.exec(stripped))) {
    const name = m[1];
    if (name in map) continue;
    if (m[2] !== undefined) map[name] = arity(m[2]); // function(...)
    else if (m[3] !== undefined) map[name] = arity(m[3]); // (...) =>
    else if (m[4] !== undefined) map[name] = 1; // x =>
    else map[name] = -1; // non-callable / unparseable RHS
  }

  // module.exports = { a, b, c } — record names only (arity unknown).
  const reCjsObj = /module\.exports\s*=\s*{([^}]*)}/g;
  while ((m = reCjsObj.exec(stripped))) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && !(name in map)) map[name] = -1;
    }
  }

  return map;
}

// Normalized default-param fingerprint per exported function: for each top-level
// param, record whether it has a default and the stripped RHS token sequence
// after '='. A changed default (port=443 -> port=80) is a behavior change even
// though arity is unchanged. Reuses the same export-locating regexes + balanced
// paren scan as extractExports so the two stay in sync. Returns name -> string.
function extractDefaultFingerprints(stripped) {
  const map = {};
  const fingerprintParams = (paramStr) => {
    // Split top-level params, then per-param capture the post-'=' RHS tokens.
    const s = paramStr;
    const parts = [];
    let depth = 0;
    let buf = '';
    for (const ch of s) {
      if (ch === '(' || ch === '[' || ch === '{') { depth++; buf += ch; }
      else if (ch === ')' || ch === ']' || ch === '}') { depth--; buf += ch; }
      else if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; }
      else buf += ch;
    }
    if (buf.trim() !== '') parts.push(buf);
    const fp = [];
    for (const p of parts) {
      const eq = p.indexOf('=');
      // Ignore '=>' and '==' false splits: only treat as default if '=' is a
      // lone assignment (not part of '==', '=>', '<=', '>=', '!=').
      if (eq >= 0 && p[eq + 1] !== '=' && p[eq + 1] !== '>' &&
          p[eq - 1] !== '!' && p[eq - 1] !== '<' && p[eq - 1] !== '>' && p[eq - 1] !== '=') {
        const rhs = p.slice(eq + 1).replace(/\s+/g, ' ').trim();
        fp.push('=' + rhs);
      } else {
        fp.push('_');
      }
    }
    return fp.join('|');
  };

  let m;
  const reExportFn = /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = reExportFn.exec(stripped))) {
    const scan = scanBalancedParens(stripped, reExportFn.lastIndex - 1);
    if (scan) map[m[1]] = fingerprintParams(scan.params);
  }
  const reExportConstArrow = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  while ((m = reExportConstArrow.exec(stripped))) {
    const scan = scanBalancedParens(stripped, reExportConstArrow.lastIndex - 1);
    if (scan && /^\s*=>/.test(stripped.slice(scan.end))) map[m[1]] = fingerprintParams(scan.params);
  }
  const reExportConstFn = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*\(/g;
  while ((m = reExportConstFn.exec(stripped))) {
    const scan = scanBalancedParens(stripped, reExportConstFn.lastIndex - 1);
    if (scan) map[m[1]] = fingerprintParams(scan.params);
  }
  return map;
}

// vm.Script parses as a CLASSIC script, which rejects ESM top-level
// import/export keywords. There is no built-in ESM parser without the
// --experimental-vm-modules flag, so we neutralize statement-position module
// keywords first (line-anchored, so we don't touch `export` inside an
// expression or string) and then let vm.Script validate everything else. This
// still catches real body-level SyntaxErrors (unbalanced braces, bad tokens),
// which is the point of the gate.
function neutralizeModuleSyntax(src) {
  return src
    .replace(/^(\s*)export\s+default\s+/gm, '$1')
    .replace(/^(\s*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '$1')
    .replace(/^\s*export\s*\{[^}\n]*\}\s*(?:from\s*['"][^'"\n]*['"])?\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+\*\s+from\s*['"][^'"\n]*['"]\s*;?\s*$/gm, '')
    .replace(/^\s*import\s+[^;\n]*;?\s*$/gm, '');
}

// node:vm is a zero-dep CLASSIC JS parser: it cannot parse TypeScript type
// syntax or JSX. The .ts/.tsx/.jsx/.mts/.cts extensions are routed here from
// JS_EXTS but vm.Script would throw SyntaxError on their type/JSX constructs and
// we'd wrongly emit a hard DIFFERENT/regressed verdict on a file the gate simply
// cannot read. Gate on EXTENSION (not a fragile source sniffer, which false-
// positives on ordinary JS) so the caller can degrade honestly to
// equivalent='unknown' + recommend_tests=true instead.
const TS_JSX_EXTS = new Set(['.ts', '.tsx', '.jsx', '.mts', '.cts']);

function parseJsOk(src, file) {
  const candidate = neutralizeModuleSyntax(src.replace(/^#![^\n]*\n?/, ''));
  try {
    // vm.Script PARSES the source (catches SyntaxError) without executing it.
    // eslint-disable-next-line no-new
    new vm.Script(candidate, { filename: file });
    return { ok: true };
  } catch (e) {
    if (e instanceof SyntaxError) return { ok: false, err: e.message };
    // A non-syntax error from the compiler is rare; treat as parse failure but
    // record the message so the caller can see why.
    return { ok: false, err: String(e && e.message ? e.message : e) };
  }
}

function compareExports(beforeMap, afterMap) {
  const notes = [];
  const beforeNames = Object.keys(beforeMap).sort();
  const afterNames = Object.keys(afterMap).sort();

  const removed = beforeNames.filter((n) => !(n in afterMap));
  const added = afterNames.filter((n) => !(n in beforeMap));

  let arityMismatch = false;
  for (const n of beforeNames) {
    if (n in afterMap) {
      const a = beforeMap[n];
      const b = afterMap[n];
      // -1 means "arity unknown" for that form; only compare when both known.
      if (a >= 0 && b >= 0 && a !== b) {
        arityMismatch = true;
        notes.push(`export '${n}' arity changed ${a} -> ${b}`);
      }
    }
  }
  if (removed.length) notes.push(`exports removed: ${removed.join(', ')}`);
  if (added.length) notes.push(`exports added: ${added.join(', ')}`);

  const match = removed.length === 0 && added.length === 0 && !arityMismatch;
  return { match, notes, total: beforeNames.length };
}

function runJs(beforeFile, afterFile, beforeSrc, afterSrc) {
  const notes = [];
  const result = {
    equivalent: 'unknown',
    syntax_ok: false,
    exports_match: false,
    notes,
    recommend_tests: true,
  };

  // (0) TS/JSX cannot be parsed by node:vm with zero deps. Rather than emit a
  // false DIFFERENT/regressed verdict on a file the gate provably cannot read,
  // degrade honestly to 'unknown' and defer to the user's test suite.
  const beforeExt = path.extname(beforeFile).toLowerCase();
  const afterExt = path.extname(afterFile).toLowerCase();
  const unparseable = TS_JSX_EXTS.has(beforeExt) || TS_JSX_EXTS.has(afterExt);
  if (unparseable) {
    notes.push(
      'TypeScript/JSX detected — node:vm cannot parse it without deps, so the ' +
        'syntax gate is skipped here (no hard verdict possible).'
    );
    notes.push(
      'Run your existing test suite (and your tsc/build) — it is the only true ' +
        'behavioral proof for this file.'
    );
    result.equivalent = 'unknown';
    result.syntax_ok = false;
    result.exports_match = true; // do not hard-fail on a file we cannot parse
    result.recommend_tests = true;
    return result;
  }

  // (1) Syntax gate.
  const pb = parseJsOk(beforeSrc, beforeFile);
  const pa = parseJsOk(afterSrc, afterFile);
  if (!pb.ok) notes.push(`before failed to parse: ${pb.err}`);
  if (!pa.ok) notes.push(`after failed to parse: ${pa.err}`);
  if (!pb.ok || !pa.ok) {
    result.syntax_ok = false;
    result.equivalent = 'DIFFERENT';
    notes.push('syntax gate FAILED — trim broke the source; revert.');
    return result;
  }
  result.syntax_ok = true;
  notes.push('syntax gate passed (parsed via node:vm, not executed).');

  // (2) Export / signature parity (weak heuristic).
  const beforeMap = extractExports(stripJs(beforeSrc));
  const afterMap = extractExports(stripJs(afterSrc));
  const cmp = compareExports(beforeMap, afterMap);
  result.exports_match = cmp.match;
  for (const nn of cmp.notes) notes.push(nn);

  if (!cmp.match) {
    result.equivalent = 'DIFFERENT';
    notes.push('export/signature parity FAILED — public surface changed; revert.');
    return result;
  }

  if (cmp.total === 0) {
    notes.push('no named/CommonJS exports detected — parity check is vacuous here.');
    result.equivalent = 'unknown';
    // No exports to scope a body comparison against; the body-fingerprint pass
    // below would compare whole-file token vectors with no signature anchor, so
    // we honestly defer to the test suite rather than risk a noisy verdict.
    notes.push(
      'JS static analysis cannot prove runtime equivalence (no AST without deps). ' +
        'Run your existing test suite — it is the only true behavioral proof.'
    );
    result.recommend_tests = true;
    return result;
  }

  notes.push(`export/signature parity held across ${cmp.total} export(s).`);
  result.equivalent = 'signature-match';

  // (3) BEHAVIOR-LEAF fingerprint (numeric/string literals, operators, await/
  // yield, regex bodies, default param values). The parity check above ignores
  // bodies; this catches body-level behavior changes that keep the same export
  // surface. A delta in a behavior-bearing LEAF is a genuine behavior change ->
  // hard 'DIFFERENT' (revert). String-literal contents are read from RAW source
  // (stripJs blanks them); operators are read from STRIPPED source so operators
  // inside strings don't count.
  const bStrip = stripJs(beforeSrc);
  const aStrip = stripJs(afterSrc);

  const leafDeltas = [];
  const litB = extractJsLiterals(beforeSrc);
  const litA = extractJsLiterals(afterSrc);
  for (const d of arrayMultisetDelta(litB.numbers, litA.numbers, 'numeric literal')) leafDeltas.push(d);
  for (const d of arrayMultisetDelta(litB.strings, litA.strings, 'string literal')) leafDeltas.push(d);
  for (const d of multisetDelta(jsOperatorMultiset(bStrip), jsOperatorMultiset(aStrip), 'operator')) leafDeltas.push(d);

  // Default-param value changes (same arity, different default).
  const dfB = extractDefaultFingerprints(bStrip);
  const dfA = extractDefaultFingerprints(aStrip);
  for (const name of Object.keys({ ...dfB, ...dfA })) {
    if ((dfB[name] || '') !== (dfA[name] || '')) {
      leafDeltas.push(`default param of '${name}' changed: ${dfB[name] || '(none)'} -> ${dfA[name] || '(none)'}`);
    }
  }

  if (leafDeltas.length) {
    result.equivalent = 'DIFFERENT';
    notes.push('body behavior-leaf change detected (heuristic, no AST):');
    for (const d of leafDeltas.slice(0, 12)) notes.push('  ' + d);
    notes.push(
      'a literal/operator/await/default changed while the export surface held — ' +
        'this is a behavior change; revert (or confirm intent and run your test suite).'
    );
    result.recommend_tests = true;
    return result;
  }

  // (4) RENAME-CANONICALIZED whole-body token-vector diff. Catches body changes
  // the leaf multisets did not (token reorder, structural edits) that survive
  // pure renames. This is a WEAKER signal than a leaf delta: it is NOT a proof
  // of behavior change, so it downgrades to 'body-changed' (recommend tests) and
  // is deliberately NOT a hard fail / does NOT auto-revert.
  const tb = jsCanonTokens(bStrip);
  const ta = jsCanonTokens(aStrip);
  if (JSON.stringify(tb) !== JSON.stringify(ta)) {
    result.equivalent = 'body-changed';
    notes.push(
      'body token-vector differs after rename-canonicalization (heuristic): the ' +
        'function body changed in a way no behavior-leaf delta explained.'
    );
    notes.push(
      'this is a SIGNAL, not a proof — not auto-reverted. Run your existing test ' +
        'suite to confirm the change preserved behavior.'
    );
    result.recommend_tests = true;
    return result;
  }

  // (5) Honest limit — bodies are token-identical modulo renames/formatting.
  notes.push(
    'JS static analysis cannot prove runtime equivalence (no AST without deps). ' +
      'Run your existing test suite — it is the only true behavioral proof.'
  );
  result.recommend_tests = true;
  return result;
}

/* --------------------------------------------------------------- Python ---- */

// Python helper executed by spawned python3. Stdlib only. Reads the two file
// paths as argv, prints a JSON object describing the comparison.
const PY_SRC = String.raw`
import ast, json, sys

def parse(path):
    with open(path, 'r', encoding='utf-8') as f:
        return ast.parse(f.read())

def toplevel_public_names(tree):
    """Names of top-level def/async-def/class nodes — the public API contract.
    These are compared as a set by signatures(); they must NOT be alpha-renamed,
    or a permutation of the public name set collapses to an identical dump and a
    real public-API behavior change is mislabeled 'modulo-renames'."""
    names = set()
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(n.name)
    return names

class AlphaNormalizer(ast.NodeTransformer):
    """Map every binding/reference name to a positional placeholder Vn so that a
    pure rename produces an identical dump. First-seen order defines the index.
    Names in pinned (top-level public def/class names) are mapped to themselves
    so the public contract is preserved verbatim through normalization."""
    def __init__(self, pinned=None):
        self.mapping = {}
        for name in (pinned or ()):
            self.mapping[name] = name
    def _norm(self, name):
        if name is None:
            return None
        if name not in self.mapping:
            self.mapping[name] = "V%d" % len(self.mapping)
        return self.mapping[name]
    def visit_Name(self, node):
        node.id = self._norm(node.id)
        return node
    def visit_arg(self, node):
        node.arg = self._norm(node.arg)
        node.annotation = None
        return self.generic_visit(node)
    def visit_FunctionDef(self, node):
        node.name = self._norm(node.name)
        node.returns = None
        return self.generic_visit(node)
    def visit_AsyncFunctionDef(self, node):
        node.name = self._norm(node.name)
        node.returns = None
        return self.generic_visit(node)
    def visit_ClassDef(self, node):
        node.name = self._norm(node.name)
        return self.generic_visit(node)

def signatures(tree):
    sigs = {}
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = n.args
            count = len(a.posonlyargs) + len(a.args) + len(a.kwonlyargs)
            count += 1 if a.vararg else 0
            count += 1 if a.kwarg else 0
            sigs[n.name] = count
        elif isinstance(n, ast.ClassDef):
            sigs[n.name] = -1
    return sigs

def dump(tree):
    try:
        return ast.dump(tree, annotate_fields=True)
    except TypeError:
        return ast.dump(tree)

def main():
    before_path, after_path = sys.argv[1], sys.argv[2]
    out = {
        "equivalent": "unknown",
        "syntax_ok": False,
        "exports_match": False,
        "notes": [],
        "recommend_tests": True,
    }
    try:
        tb = parse(before_path)
    except SyntaxError as e:
        out["notes"].append("before failed to parse: %s" % e); out["equivalent"]="DIFFERENT"
        print(json.dumps(out)); return
    try:
        ta = parse(after_path)
    except SyntaxError as e:
        out["notes"].append("after failed to parse: %s" % e); out["equivalent"]="DIFFERENT"
        print(json.dumps(out)); return

    out["syntax_ok"] = True
    out["notes"].append("syntax gate passed (ast.parse on both).")

    # Signature parity (top-level defs).
    sb, sa = signatures(tb), signatures(ta)
    removed = sorted(set(sb) - set(sa))
    added = sorted(set(sa) - set(sb))
    arity_bad = False
    for name in sorted(set(sb) & set(sa)):
        if sb[name] >= 0 and sa[name] >= 0 and sb[name] != sa[name]:
            arity_bad = True
            out["notes"].append("def '%s' arity changed %d -> %d" % (name, sb[name], sa[name]))
    if removed: out["notes"].append("top-level defs removed: %s" % ", ".join(removed))
    if added:   out["notes"].append("top-level defs added: %s" % ", ".join(added))
    out["exports_match"] = (not removed and not added and not arity_bad)

    if not out["exports_match"]:
        out["equivalent"] = "DIFFERENT"
        out["notes"].append("signature parity FAILED — public surface changed; revert.")
        print(json.dumps(out)); return

    # (a) exact structural diff.
    if dump(tb) == dump(ta):
        out["equivalent"] = "identical"
        out["notes"].append("ASTs structurally identical (format/paren/comment-only change).")
        out["recommend_tests"] = False
        print(json.dumps(out)); return

    # (b) rename-insensitive diff. Pin top-level public names (the API contract)
    # so a permutation of the public name set cannot collapse to an identical
    # normalized dump.
    pb_tree, pa_tree = parse(before_path), parse(after_path)
    nb = dump(AlphaNormalizer(toplevel_public_names(pb_tree)).visit(pb_tree))
    na = dump(AlphaNormalizer(toplevel_public_names(pa_tree)).visit(pa_tree))
    if nb == na:
        out["equivalent"] = "modulo-renames"
        out["notes"].append("ASTs identical modulo renames (alpha-normalized dumps match).")
        out["recommend_tests"] = False
        print(json.dumps(out)); return

    # Structurally different but signatures held. Before settling on the soft
    # 'signature-match' verdict, walk BOTH trees and collect a MULTISET of
    # behavior-bearing LEAF facts that survive alpha-normalization: literal
    # values, operator node classes (Eq vs Is, Add vs Sub, Lt vs LtE, And vs Or,
    # ...), await/yield counts, and default param values. A delta here is a
    # genuine behavior change -> hard 'DIFFERENT' (revert). This branch runs ONLY
    # on the already-structurally-different path, so it cannot touch the
    # identical / modulo-renames / signature-parity-fail verdicts above.
    def leaf_facts(tree):
        facts = {}
        def bump(k, by=1):
            facts[k] = facts.get(k, 0) + by
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant):
                bump("lit:%r" % (node.value,))
            elif isinstance(node, (ast.Await,)):
                bump("await")
            elif isinstance(node, (ast.Yield, ast.YieldFrom)):
                bump("yield")
            elif isinstance(node, (ast.BoolOp,)):
                bump("op:%s" % type(node.op).__name__, len(node.values) - 1)
            elif isinstance(node, ast.BinOp):
                bump("op:%s" % type(node.op).__name__)
            elif isinstance(node, ast.UnaryOp):
                bump("op:%s" % type(node.op).__name__)
            elif isinstance(node, ast.AugAssign):
                bump("op:Aug%s" % type(node.op).__name__)
            elif isinstance(node, ast.Compare):
                for o in node.ops:
                    bump("cmp:%s" % type(o).__name__)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                a = node.args
                for d in list(a.defaults) + [x for x in a.kw_defaults if x is not None]:
                    if isinstance(d, ast.Constant):
                        bump("default:%r" % (d.value,))
                    else:
                        bump("default:expr")
        return facts

    fb, fa = leaf_facts(tb), leaf_facts(ta)
    leaf_deltas = []
    for k in sorted(set(fb) | set(fa)):
        if fb.get(k, 0) != fa.get(k, 0):
            leaf_deltas.append("%s x%d -> x%d" % (k, fb.get(k, 0), fa.get(k, 0)))
    if leaf_deltas:
        out["equivalent"] = "DIFFERENT"
        out["notes"].append("body behavior-leaf change detected (AST literal/operator/await/default):")
        for d in leaf_deltas[:12]:
            out["notes"].append("  " + d)
        out["notes"].append("a behavior-bearing leaf changed while signatures held — revert (or confirm intent and run your test suite).")
        out["recommend_tests"] = True
        print(json.dumps(out)); return

    # Structurally different, signatures held, no behavior-leaf delta: a real but
    # leaf-neutral logic change (reorder, added/removed statement). Soft signal.
    out["equivalent"] = "body-changed"
    out["notes"].append("signatures + behavior-leaves match but AST structure differs — body changed.")
    out["notes"].append("this is a SIGNAL, not a proof — not auto-reverted. Run your test suite.")
    out["recommend_tests"] = True
    print(json.dumps(out))

main()
`;

function runPython(beforeFile, afterFile) {
  const py = process.env.PYTHON || 'python3';
  const res = spawnSync(py, ['-c', PY_SRC, beforeFile, afterFile], {
    encoding: 'utf8',
  });

  if (res.error || res.status !== 0 || !res.stdout) {
    // Distinguish a missing/unspawnable interpreter (res.error: ENOENT etc.)
    // from one that ran but exited non-zero (e.g. a runtime error like
    // IsADirectoryError). Mislabeling the latter as "unavailable" hides the
    // real cause from the operator.
    const headline = res.error
      ? `python3 path unavailable (${res.error.message}).`
      : `python3 ast check failed (exit ${res.status}).`;
    const notes = [
      headline,
      'Could not run the stdlib ast equivalence check.',
      'Run your existing test suite to verify the trim preserved behavior.',
    ];
    if (res.stderr) notes.push(`python stderr: ${res.stderr.trim().split('\n').slice(-1)[0]}`);
    return {
      equivalent: 'unknown',
      syntax_ok: false,
      exports_match: false,
      notes,
      recommend_tests: true,
    };
  }

  try {
    const parsed = JSON.parse(res.stdout.trim().split('\n').slice(-1)[0]);
    return parsed;
  } catch (e) {
    return {
      equivalent: 'unknown',
      syntax_ok: false,
      exports_match: false,
      notes: [`could not parse python output: ${e.message}`, 'Run your test suite.'],
      recommend_tests: true,
    };
  }
}

/* ------------------------------------------------------------------ main --- */

function main() {
  const [beforeFile, afterFile] = process.argv.slice(2);
  if (!beforeFile || !afterFile) {
    fail('usage: node lib/equivalence.js <before> <after>');
  }
  if (!fs.existsSync(beforeFile)) fail(`no such file: ${beforeFile}`);
  if (!fs.existsSync(afterFile)) fail(`no such file: ${afterFile}`);
  // Reject directories uniformly across both language paths (the JS path reads
  // in-process and throws EISDIR -> exit 2, while the Python path defers the
  // open() to the interpreter and would degrade to a confusing exit-0 unknown).
  for (const f of [beforeFile, afterFile]) {
    if (!fs.statSync(f).isFile()) fail(`not a regular file: ${f}`);
  }

  const ext = path.extname(afterFile).toLowerCase();

  let result;
  if (PY_EXTS.has(ext)) {
    result = runPython(beforeFile, afterFile);
  } else if (JS_EXTS.has(ext)) {
    const beforeSrc = readFileOr(beforeFile);
    const afterSrc = readFileOr(afterFile);
    result = runJs(beforeFile, afterFile, beforeSrc, afterSrc);
  } else {
    result = {
      equivalent: 'unknown',
      syntax_ok: false,
      exports_match: false,
      notes: [
        `unsupported extension '${ext}' — no static gate available.`,
        'Run your existing test suite to verify behavior was preserved.',
      ],
      recommend_tests: true,
    };
  }

  // Normalize shape defensively in case the python path returned partial JSON.
  result.equivalent = result.equivalent || 'unknown';
  result.syntax_ok = !!result.syntax_ok;
  result.exports_match = !!result.exports_match;
  result.notes = Array.isArray(result.notes) ? result.notes : [];
  result.recommend_tests =
    result.recommend_tests === undefined ? true : !!result.recommend_tests;
  if (!(result.equivalent in RANK)) result.equivalent = 'unknown';

  emit(result);
}

main();
