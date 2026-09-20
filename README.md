# ai-runtime — shared AI runtime package

Shared runtime used by the domains (FILMIUM/KALIMA/CODIUM/IMPERIUM) and, when needed, by
apps. Publishing this as one repo lets any machine bootstrap it via
`bootstrap-ai-runtime.sh` (see below).

## Components
| Folder | What | Port |
|---|---|---|
| `cell-shell/` | Electron shell (domain GUIs) | — |
| `router-api/` | ai-router (deterministic cross-domain routing) | `:4800` |
| `vector-dbs/` | qdrant + `global_graph_vault` (config/schema only here) | `:6333` |
| `second-brain/` | visual GUI | `:4901` |
| `tools/` | shared python tools |

`runtime.json` marks the runtime root; `runtime.sh` / `resolve-ai-runtime.sh` /
`bootstrap-ai-runtime.sh` manage resolve + install.

## What is NOT in this repo (installer provides it)
`node_modules/`, `dist/` (builds), the **qdrant binary**, and all **runtime data**
(`vector-dbs/qdrant/`, `vector-dbs/global_graph_vault/`) are **git-ignored** — the
installer builds/downloads them. So the repo carries **source only** (no large deps, no data).

## Install on a machine
```bash
git clone <THIS-REPO-URL> ~/.local/share/ai-runtime
~/.local/share/ai-runtime/runtime.sh install   # npm ci, tsc build, enable services
~/.local/share/ai-runtime/runtime.sh status
```
`runtime.sh install` builds `cell-shell` (`npm ci`), the router (`tsc`), and **auto-downloads
the qdrant binary** (matching your CPU arch; `QDRANT_VERSION` to override). It skips anything
already present, so it is safe to re-run. OS tools you install yourself: `git`, `node`/`npm`,
`python3`, `python3-gi`, `gir1.2-gtk-3.0`, `xdotool`.

## How domains find it (portable, no hardcoded paths)
Each domain bundles `bootstrap-ai-runtime.sh` and calls it from `start.sh`. It resolves the
runtime via `$AI_RUNTIME` → `~/ai/core-infrastructure` → `~/.local/share/ai-runtime` →
`/opt/ai-runtime` (first with `runtime.json`), and if none is found it **clones this repo and
installs it**.

---

## ⚙️ Set these as YOUR OWN before pushing / on another account

This package is wired to one GitHub account by default. To use your own, set these:

1. **Owner / repo** — the default bootstrap URL is
   `https://github.com/H4K3R0S/ai-runtime.git`. If you use a different account/name, set it
   per machine:
   ```bash
   export AI_RUNTIME_REPO="https://github.com/<YOUR-USER>/<YOUR-REPO>.git"
   ```
   (or edit the default in `bootstrap-ai-runtime.sh` and each domain's copy).

2. **Where it installs** (optional):
   ```bash
   export AI_RUNTIME_HOME="$HOME/.local/share/ai-runtime"   # default
   ```

3. **Your GitHub token — store it in SEF, never in git**:
   put a PAT (`repo` scope, or fine-grained Contents: Read/write) in the SEF vault, e.g.
   profile `<YOUR-PROFILE>` / account `github` / field `github_ai_token`. Pushes read it
   from there via `GIT_ASKPASS` (the token is never written to `.git/config` or committed).

## Pushing updates (from the dev machine)
Two ways:
- Direct to this repo:
  ```bash
  # token comes from SEF; never typed into git config
  git -C ~/ai/core-infrastructure push
  ```
- Or via the workplace helper (recommended), which pulls the token from SEF:
  ```bash
  SEF_MASTER=… ~/ai/ai_workplace/scripts/push_online.py core-infrastructure --repo ai-runtime
  ```

## Security
- **No secrets in this repo** (scanned): no tokens, passwords, keys, `.env`, or absolute
  user paths in code. Tokens live only in **SEF**.
- Runtime **data** (qdrant storage, global graph vault) is git-ignored — never published.
