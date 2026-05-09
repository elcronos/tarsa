# Vendored: claude-code-web

This directory contains a snapshot of [`vultuk/claude-code-web`](https://github.com/vultuk/claude-code-web)
(MIT licensed — see `LICENSE`) used by Tarsa to embed an in-browser terminal
for an active Claude Code session.

## Why vendor instead of `npm i`

- License boundary stays explicit and visible in the repo tree.
- Lets us patch the upstream UI to match Tarsa's visual identity without
  diverging from a published npm version.
- Pinned snapshot — no surprise breakage on upstream releases.

## What was stripped

Removed at vendor time to keep the tree small:

- `.cursor/`, `.github/`, `.prompts/` — upstream tooling, irrelevant here.
- `docs/`, `test/`, `scripts/` — not used at runtime.
- `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` — upstream contributor docs.
- `package-lock.json` — root workspace lockfile is authoritative.
- `.gitignore`, `.npmignore` — root `.gitignore` covers it.

## Tarsa-specific patches

Tracked in `tarsa-patches/` (added later as we customize). Keep upstream `src/`
files mostly intact so a future re-vendor is mechanical.

## Re-vendoring

```sh
cd /tmp && git clone --depth 1 https://github.com/vultuk/claude-code-web.git
rsync -a --delete /tmp/claude-code-web/ vendor/cc-web/ \
  --exclude .git --exclude .cursor --exclude .github --exclude .prompts \
  --exclude docs --exclude test --exclude scripts \
  --exclude AGENTS.md --exclude CLAUDE.md --exclude CONTRIBUTING.md \
  --exclude package-lock.json --exclude .gitignore --exclude .npmignore
# re-apply tarsa-patches/*.patch
```
