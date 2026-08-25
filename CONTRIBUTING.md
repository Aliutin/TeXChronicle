# Contributing to TeXChronicle

Thanks for wanting to help. This project is maintained by one person, so the
process below exists to keep review load sane — not to be bureaucratic.

## Open an issue first

**Please open an issue before you open a pull request**, and wait for a reply.

This isn't a formality. TeXChronicle has a few load-bearing design decisions that
aren't obvious from the code (why the compile engine lives in a hidden headless
browser, why checkpoints go to a hidden git ref instead of your branches, why
the UI can't run an AI review itself). A PR that cuts against one of those is a
lot of wasted work for you and an awkward conversation for me. A short issue
first means I can say "yes, and here's the gotcha" before you write anything.

Exceptions where you can skip straight to a PR: typo fixes, broken links,
obviously-wrong documentation, and translation corrections.

Link the issue from your PR (`Fixes #123`) — the PR template asks for it, and
CI checks that it's there.

## Before you push

```bash
npm install
npm run typecheck    # server + UI
npm run build:ui
npm test
```

All three must pass; CI runs exactly these on Node 20 and 22. The tests are
engine-free (no headless browser, no WASM download), so they're fast — please
keep them that way, and add coverage alongside behaviour changes.

## Things worth knowing

- **Changing anything in `src/` needs a Claude Code restart to take effect** —
  the MCP server is a long-lived process. UI-only changes just need a hard
  refresh of the workspace tab.
- **The workspace UI has no agent in it.** MCP tools are Claude→server only; the
  browser can't make Claude do anything. Features like "run a review from a
  button in the UI" are architecturally impossible as stated — see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- **Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** before touching the
  compile path, the checkpoint plumbing, or the comment store. It documents
  which invariants are deliberate.
- Comments and checkpoints are shared across concurrently-running MCP server
  processes; anything that mutates them must go through `src/lock.ts`. See
  [`docs/ROADMAP.md`](docs/ROADMAP.md).
- **Line endings are pinned in `.gitattributes`** (`* text=auto`), so a Windows
  checkout no longer turns into a whole-file diff. If your clone shows files as
  modified with nothing actually changed in them, run `git add --renormalize .`
  once and commit that by itself — it corrects what the index recorded before the
  rule existed, and never needs doing twice.

## Translations

Docs live in 8 languages under `docs/i18n/`. If you change an English doc,
you don't have to update all 7 translations — say so in the PR and I'll handle
it, or leave it for a follow-up. Translation fixes on their own are very
welcome and don't need an issue first.

## Licence

TeXChronicle is AGPL-3.0-or-later. By contributing you agree your contribution is
licensed under the same terms.
