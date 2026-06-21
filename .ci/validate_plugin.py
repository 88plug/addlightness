#!/usr/bin/env python3
"""Validate the addlightness plugin structure.

Single-manifest layout: `.claude-plugin/plugin.json` is THE manifest Claude Code
reads (it carries hooks + version), matching every shipped 88plug plugin. There is
deliberately NO root plugin.json. Exit non-zero on any failure.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []
checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        fails.append(msg)


def load_json(rel):
    p = ROOT / rel
    check(p.is_file(), f"missing file: {rel}")
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError as e:
        fails.append(f"invalid JSON in {rel}: {e}")
        return None


# --- manifest ---------------------------------------------------------------
mani = load_json(".claude-plugin/plugin.json")
if mani:
    for field in ("name", "description", "version", "license", "keywords", "hooks"):
        check(field in mani, f"manifest missing required field: {field}")
    kw = mani.get("keywords", [])
    check(len(kw) == 20, f"manifest must have exactly 20 keywords, has {len(kw)}")
    check(len(kw) == len(set(kw)), "manifest keywords contain duplicates")
    check(mani.get("name") == "addlightness", "manifest name must be 'addlightness'")

    # every hook command path must resolve on disk
    for event, groups in (mani.get("hooks") or {}).items():
        for group in groups:
            for hook in group.get("hooks", []):
                cmd = hook.get("command", "")
                for m in re.findall(r"\$\{CLAUDE_PLUGIN_ROOT\}/([^\"]+)", cmd):
                    check((ROOT / m).is_file(), f"hook {event} references missing file: {m}")
                check(isinstance(hook.get("timeout"), int), f"hook {event} timeout must be int seconds")

# --- discovery extras -------------------------------------------------------
mkt = load_json(".claude-plugin/marketplace.json")
if mkt:
    check(mkt.get("name") == "addlightness", "marketplace.json name must be 'addlightness'")
    check(isinstance(mkt.get("plugins"), list) and mkt["plugins"], "marketplace.json needs a plugins array")
load_json("marketplace-entry.json")
load_json("package.json")

# --- agents & skills frontmatter -------------------------------------------
for agent in (ROOT / "agents").glob("*.md"):
    txt = agent.read_text()
    check(txt.startswith("---"), f"agent {agent.name} missing YAML frontmatter")
    check("name:" in txt and "description:" in txt and "tools:" in txt,
          f"agent {agent.name} frontmatter missing name/description/tools")

for skill in (ROOT / "skills").glob("*/SKILL.md"):
    txt = skill.read_text()
    check(txt.startswith("---"), f"skill {skill.parent.name} missing YAML frontmatter")
    check("name:" in txt and "description:" in txt,
          f"skill {skill.parent.name} frontmatter missing name/description")

# --- engines parse ----------------------------------------------------------
for js in list((ROOT / "lib").glob("*.js")) + list((ROOT / "hooks").glob("*.js")):
    r = subprocess.run(["node", "--check", str(js)], capture_output=True, text=True)
    check(r.returncode == 0, f"node --check failed: {js.relative_to(ROOT)}: {r.stderr.strip()}")

for sh in (ROOT / "scripts").glob("*.sh"):
    r = subprocess.run(["bash", "-n", str(sh)], capture_output=True, text=True)
    check(r.returncode == 0, f"bash -n failed: {sh.relative_to(ROOT)}: {r.stderr.strip()}")

# --- report -----------------------------------------------------------------
if fails:
    print(f"FAIL ({len(fails)}/{checks} checks failed):")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print(f"OK: {checks} checks passed")
