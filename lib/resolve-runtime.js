#!/usr/bin/env node
'use strict';

/*
 * resolve-runtime.js — locate python3/node under thin Claude Code PATH.
 *
 * Claude Code hooks/MCP often spawn with a minimal PATH (no Homebrew/pyenv).
 * Bare `python3` then misses real interpreters. Honor fleet overrides first,
 * then absolute well-known paths, then bare names for PATH lookup at spawn.
 *
 * Env order (Python):
 *   EIGHTYEIGHT_PYTHON → PLUGIN_PYTHON → ADDLIGHTNESS_PYTHON → PYTHON
 * Env order (Node):
 *   EIGHTYEIGHT_NODE → PLUGIN_NODE → ADDLIGHTNESS_NODE → NODE
 *   (else process.execPath, then absolute candidates, then bare 'node')
 */

const fs = require('node:fs');
const path = require('node:path');

let _python;
let _node;

function isRunnable(p) {
  if (!p || typeof p !== 'string') return false;
  // Absolute/relative path: must exist and be executable.
  if (p.includes('/') || (path.sep !== '/' && p.includes(path.sep))) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  // Bare name (python3, node) — defer to PATH at spawn time.
  return true;
}

function firstEnv(keys) {
  for (const key of keys) {
    const v = process.env[key];
    if (v && isRunnable(v)) return v;
  }
  return null;
}

function firstAbs(candidates) {
  for (const c of candidates) {
    if (c && isRunnable(c)) return c;
  }
  return null;
}

function homeJoin(...parts) {
  const home = process.env.HOME;
  if (!home) return '';
  return path.join(home, ...parts);
}

function resolvePython() {
  if (_python !== undefined) return _python;

  const fromEnv = firstEnv([
    'EIGHTYEIGHT_PYTHON',
    'PLUGIN_PYTHON',
    'ADDLIGHTNESS_PYTHON',
    'PYTHON',
  ]);
  if (fromEnv) {
    _python = fromEnv;
    return _python;
  }

  const abs = firstAbs([
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    homeJoin('.local', 'bin', 'python3'),
    '/usr/bin/python',
  ]);
  if (abs) {
    _python = abs;
    return _python;
  }

  _python = 'python3';
  return _python;
}

function resolveNode() {
  if (_node !== undefined) return _node;

  const fromEnv = firstEnv([
    'EIGHTYEIGHT_NODE',
    'PLUGIN_NODE',
    'ADDLIGHTNESS_NODE',
    'NODE',
  ]);
  if (fromEnv) {
    _node = fromEnv;
    return _node;
  }

  // Already running under node — best default for any re-spawn.
  if (process.execPath && isRunnable(process.execPath)) {
    _node = process.execPath;
    return _node;
  }

  const abs = firstAbs([
    '/usr/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    homeJoin('.local', 'bin', 'node'),
  ]);
  if (abs) {
    _node = abs;
    return _node;
  }

  _node = 'node';
  return _node;
}

/** Test helper — clear memoized resolutions. */
function _resetCache() {
  _python = undefined;
  _node = undefined;
}

module.exports = { resolvePython, resolveNode, _resetCache };

if (require.main === module) {
  const which = process.argv[2] || 'python';
  const out = which === 'node' ? resolveNode() : resolvePython();
  process.stdout.write(out + '\n');
}
