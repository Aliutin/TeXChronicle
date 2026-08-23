# Architecture

**English** · [简体中文](i18n/ARCHITECTURE.zh-CN.md) · [日本語](i18n/ARCHITECTURE.ja.md) · [한국어](i18n/ARCHITECTURE.ko.md) · [Español](i18n/ARCHITECTURE.es.md) · [Français](i18n/ARCHITECTURE.fr.md) · [Deutsch](i18n/ARCHITECTURE.de.md) · [Português](i18n/ARCHITECTURE.pt.md)

## Why a headless browser

The WASM TeX Live engines (`texlyre-busytex`, and SwiftLaTeX before it) are
browser libraries: they call `document.createElement('script')` and
`new Worker(...)` internally and cannot run in a bare Node process. So the MCP
server launches a **hidden headless Chromium** (via Playwright) as its compile
worker. The engine initializes once there and is reused for every compile.

A side benefit: because the engine lives in the hidden browser, the tab **you**
open is the React workspace with a lightweight `pdf.js` viewer — no WASM in it.

## Pieces

- `src/server.ts` — MCP stdio server; registers all 7 tools (below). Everything
  heavy is lazy: the engine, preview server, and file watcher start on the first
  `render_preview` call, not on connect.
- `src/tools/*ToolDef.ts` — one file per tool group, each exporting its name +
  Zod input schema + description: `renderPreviewToolDef.ts`, `commentsToolDefs.ts`
  (`check_comments` / `resolve_comment` / `add_comment` / `reply_to_comment`),
  `showDiffToolDef.ts`, `listCheckpointsToolDef.ts`.
- `src/lock.ts` — cross-process mutex (exclusive lockfile + stale-owner recovery)
  for state shared across concurrently-running MCP server processes: each Claude
  Code session spawns its own `tsx server.ts` (stdio MCP = one child per client),
  so an in-process lock alone wouldn't protect two sessions working the same
  project. See [`ROADMAP.md`](ROADMAP.md).
- `src/engine/browserHost.ts` — singleton headless Chromium + engine host page;
  exposes `compile(files, mainTexPath, engine)`. Keeps the engine initialized once.
- `src/engine/hostPage.ts` — the hidden page's HTML; imports the WASM engine and
  exposes `window.__compile`. Data-package names carry a `.js` suffix (they're
  passed raw to `importScripts`); binary figures arrive base64-encoded.
- `src/engine/assets.ts` — first-run download of the WASM TeX Live assets.
- `src/engine/fallbackStyles.ts` — vendors `.sty` files the bundled TeX Live subset
  omits (algorithms family, multirow, a `bbm` approximation) and injects them at
  compile time when the project doesn't ship its own copy.
- `src/preview/previewServer.ts` — one local HTTP+WS server: serves the engine host
  page + WASM assets to the hidden browser; the workspace (`/app`, from `ui/dist`)
  or the legacy inline viewer (`src/preview/viewerPage.ts`, only if `ui/dist` is
  missing); `/api/*` (files, comments, upload); `/git/*` (checkpoints, diff,
  status, semantic sections, section diffs/restores, historical PDFs); inverse
  SyncTeX queries for the current system-TeX render; `/export.zip` +
  `/overleaf/link`. All responses carry COOP/COEP headers
  (the engine's Worker/SharedArrayBuffer require cross-origin isolation).
- `src/preview/filesApi.ts` — the file tree + read/write/rename/delete/upload
  behind `/api/*`, path-guarded against traversal.
- `src/preview/commentsStore.ts` — comments persisted in
  `<project>/.latex-preview/comments.json` (atomic write: temp file + rename), all
  mutations behind `lock.ts`. Status flow: `suggested` → (human accepts) →
  `accepted` → (author resolves) → `resolved`.
- `src/preview/anchorMatch.ts` — best-effort quote → `{file, line}` lookup, so
  `check_comments` can point Claude at a location without a real index.
- `src/preview/diffViewPage.ts` — the hidden page `show_diff` screenshots to
  return a diff as an image.
- `src/project/*` — `resolveMainFile` (find `\documentclass`), `collectProjectFiles`
  (gather the project tree), `compileProject` (the shared compile), `parseLog`
  (TeX log → `{file, line, message}`).
- `src/export/overleafZip.ts` — builds a clean build-inputs zip (excludes compiled
  PDFs, `.git`, `.latex-preview`) for `/export.zip` and Overleaf's "Upload Project".
- `src/git/historyRepo.ts` — decides where a project's history lives. A git repo keeps it
  on the hidden ref inside itself; a plain folder gets a repository of ours at
  `.latex-preview/history.git` with the project as its work tree, so the history follows the
  paper instead of the path — it moves, copies and is deleted with the folder, and `git` run
  there still reports no repository. Pre-0.1.9 histories lived in the per-user cache under a
  hash of the path; one is brought forward only when its recorded bytes still match a file on
  disk, so a reused path cannot inherit a different project's checkpoints.
- `src/git/checkpoints.ts` — Zed-style auto-checkpoints. On each successful compile,
  snapshots the working tree into a parallel commit chain under a **hidden ref**
  (`refs/latex-preview/checkpoints`) using a temp index (`GIT_INDEX_FILE`), so the
  user's working tree / index / HEAD / branches are never touched. Every mutating
  operation (`createCheckpoint`, `restoreCheckpoint`, `restoreFile`) runs under
  `lock.ts`. Diffs and the checkpoint list exclude `.latex-preview/` and `.claude/`
  (git exclude pathspec) — neither is part of the user's paper.
- `src/latex/sections.ts` — offset-preserving LaTeX section parser and semantic graph builder.
  It separates a section's direct text from its complete subtree, then matches identities between
  checkpoints using labels plus fuzzy title/content/hierarchy/neighbour/order evidence.
- `src/git/sectionHistory.ts` — projects the hidden checkpoint chain into per-section timelines;
  follows the main file recorded with each render through its `\input`/`\include` graph (so old
  standalone drafts in the same folder do not pollute the tree), produces section-only diffs, and
  performs reversible subtree restores without changing unrelated parts of the document.
- `src/git/renderArtifacts.ts` — stores and validates the exact successful PDF for each source
  checkpoint under `.latex-preview/renders/`, outside Git's binary history but inside the project
  for folder synchronization.
- `src/git/remote.ts` — parses the GitHub remote (if any) to build the
  Open-in-Overleaf link for public repos.
- `src/coordinator.ts` — serializes all compiles **within one process** (tool +
  watcher) through one promise chain. It captures a Git tree before compilation and,
  after a clean result, commits and binds the PDF only if the working tree still
  matches; a save during compilation therefore cannot mislabel a stale PDF. Cross-process
  serialization for shared state is `lock.ts`'s job, not this — the coordinator only
  owns the WASM engine, which is itself per-process.
- `src/watch/fileWatcher.ts` — chokidar watcher for passive live-reload.
- `src/session.ts` — the current project root, shared between the coordinator
  (which sets it) and the git/comments endpoints (which read it), without an
  import cycle.

## Compile flow

```
render_preview ─┐                         ┌─ clean + same tree ─▶ checkpoint + exact PDF
                ├─▶ coordinator (serial) ┼─ setLatestPdf ─▶ WS "reload" ─▶ workspace
file save ──────┘       pre-compile tree  └─ compile-error ─▶ WS ─▶ workspace banner
                         │
                         ├─ resolveMainFile + collectProjectFiles
                         └─ browserHost.compile → page.evaluate(window.__compile)
                                                   → BusyTexRunner (reused) → PDF
```

## The workspace UI (`ui/`)

A Vite+React+TS app built to `ui/dist` (`npm run build:ui`) and served statically by the
preview server at `/app` — same origin as the API and WebSocket, so no proxy/CORS. The server
falls back to the legacy inline `/viewer` when `ui/dist` is missing (fresh clone before a build).

- `ui/src/App.tsx` — persistent Code / Visual / PDF / Split / History workspaces. Focused
  views give one task the canvas without unmounting the editor; Comments remains a right drawer.
- `ui/src/components/Toolbar.tsx` — brand mark + doc title, Recompile, comments toggle,
  Export .zip / Download PDF.
- `ui/src/components/PdfView.tsx` — pdf.js canvas + **text layer** (selectable) + highlight
  layer; a PDF point is converted to 72-dpi page coordinates for inverse SyncTeX, while text
  selection opens the comment composer. Highlights are **re-anchored to the live
  text on every render** (matching a comment's quote by head/tail phrase, progressively
  shortened) rather than pinned to frozen coordinates, so they track reflow after an edit;
  shaped like a text selection (first/last line partial, middle lines flush full-width) so a
  multi-line highlight doesn't fragment on font-metric quirks (italics, inline math).
- `ui/src/components/SourcePanel.tsx` — CodeMirror 6 LaTeX editor (Code/Visual modes, line
  wrap toggle) over `/api/files` + `/api/file` (GET/PUT, path-guarded); autosaves every 30s
  without recompiling, Ctrl+S / Save / Recompile rebuild on demand; uses a vertical tree in
  Split and a resizable tree sidebar in focused Code/Visual; opens the exact SyncTeX file/line
  and uses nearby rendered prose to refine macro-expanded blocks.
- `ui/src/components/FileTree.tsx` — nested Overleaf-style file tree: new/rename/delete,
  figure upload, resizable height.
- `ui/src/components/HistoryPanel.tsx` + `DiffView.tsx` — semantic section tree and version graph
  by default, with direct-text/subtree diffs, historical-PDF links, confidence markers, and
  reversible section restore. The original whole-project checkpoint timeline remains available,
  including per-checkpoint and per-file restore.
- `ui/src/components/CommentsPanel.tsx` — suggested/accepted/resolved cards, the Auto-accept
  (copilot) toggle, jump-to-highlight.
- Comment MCP loop: `check_comments` returns accepted comments as structured instructions;
  `resolve_comment` marks one resolved with a note; both ends stay in sync via the
  `comments-changed` WS event.

## Out of scope (for now)

See [`ROADMAP.md`](ROADMAP.md) for what's shipped vs. planned in more detail. In short:
true concurrent multi-agent editing (reviewer/author/defender each actually editing at the
same time, on their own git branches, merged back together) is the next milestone — today's
cross-process lock (`src/lock.ts`) makes concurrent *sessions* safe against data loss, but
they still take turns rather than truly parallel-editing the same file.
