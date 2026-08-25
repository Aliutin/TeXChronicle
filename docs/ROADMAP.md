# Roadmap

**English** · [简体中文](i18n/ROADMAP.zh-CN.md) · [日本語](i18n/ROADMAP.ja.md) · [한국어](i18n/ROADMAP.ko.md) · [Español](i18n/ROADMAP.es.md) · [Français](i18n/ROADMAP.fr.md) · [Deutsch](i18n/ROADMAP.de.md) · [Português](i18n/ROADMAP.pt.md)

## Shipped: safe concurrent use of TeXChronicle's own state

Each Claude Code session that connects to a project's `texchronicle` MCP server spawns
its **own separate process** (stdio MCP = one child process per client) — so two
sessions working on the same paper share no in-memory state. Nothing stopped two
of them from racing on the same on-disk files.

- **Cross-process lock** (`src/lock.ts`) — an exclusive lockfile at
  `.latex-preview/.lock`, acquired via atomic create (`O_EXCL`), with staleness
  recovery (a dead owner PID or a lock older than 30s is cleared automatically, so
  a crashed agent can't permanently block the others).
- **What it protects**: `add_comment` / `resolve_comment` / `reply_to_comment` /
  reject-and-delete (all of `commentsStore.ts`'s mutators) and checkpoint creation
  / restore (`createCheckpoint`, `restoreCheckpoint`, `restoreFile`) each now run
  their full read-modify-write as one cross-process critical section, instead of
  read → mutate → write with no exclusion.
- **Atomic writes** — `comments.json` is written to a temp file and renamed over
  the target, so a concurrent read (which stays unlocked — reads never needed to
  block) never observes a half-written file.
- Verified: two genuinely separate OS processes hammering `add_comment`
  concurrently lose zero writes; a lock left behind by a dead process clears in
  under 100ms instead of blocking the timeout.

**What this does *not* cover**: two agents editing the *same* `.tex` file at the
same moment through the normal file-edit tool. That write happens directly to
disk, entirely outside our MCP server — no lock we add can mediate it. If you
want to experiment with two agents today, keep them on non-overlapping files
(one on `intro.tex`, another on `related-work.tex`) until the milestone below
ships.

## Next milestone: real multi-agent (parallel editing)

Reviewer, author, and defender agents working the same paper *at the same time*,
each actually editing prose concurrently — not just taking turns through a shared
lock.

- **Direction**: per-agent isolation via git worktrees/branches. Each agent works
  in its own worktree, compiles independently; a coordination step (human review,
  or an integrator agent) merges branches back into the project.
- **Needs**: worktree lifecycle management (create per agent run, clean up after
  merge/abandon), a merge-conflict UX (paragraph-level conflicts are a content
  problem, not just a git one — surfacing them needs thought), probably a
  per-branch PDF preview or a "merge, then recompile" step, and new MCP
  tools/commands to launch and track parallel agent runs.
- **Not started.** The lock above is a real safety net regardless of whether this
  ships — it's what makes "someone left a second Claude Code session open on this
  project" safe today instead of a silent-data-loss trap.
