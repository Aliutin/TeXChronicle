#!/usr/bin/env node
// TeXChronicle MCP stdio server exposing one tool, render_preview.
// Everything heavy (headless browser, WASM engine, preview server, file watcher)
// is lazily started on the first render_preview call, so merely connecting is cheap.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import open from 'open';
import { RENDER_PREVIEW_NAME, renderPreviewConfig } from './tools/renderPreviewToolDef.js';
import { SHOW_DIFF_NAME, showDiffConfig } from './tools/showDiffToolDef.js';
import { LIST_CHECKPOINTS_NAME, listCheckpointsConfig } from './tools/listCheckpointsToolDef.js';
import { CHECK_COMMENTS_NAME, checkCommentsConfig, RESOLVE_COMMENT_NAME, resolveCommentConfig, ADD_COMMENT_NAME, addCommentConfig, REPLY_COMMENT_NAME, replyCommentConfig } from './tools/commentsToolDefs.js';
import { listComments, updateComment, addComment, addReply } from './preview/commentsStore.js';
import { findAnchor } from './preview/anchorMatch.js';
import { getPreview, peekPreview, captureDiff, shutdownEngine } from './engine/browserHost.js';
import { setConfig, requestCompile } from './coordinator.js';
import { setProjectRoot } from './session.js';
import { startWatching, stopWatching } from './watch/fileWatcher.js';
import { canTrackHistory, historyStatus, listCheckpoints, latestCheckpointSha, matchingCheckpointSha } from './git/checkpoints.js';
import { type Engine, type Backend } from './project/compileProject.js';
import { MainFileError } from './project/resolveMainFile.js';
import { summarizeErrors } from './project/parseLog.js';
import { INSTALL_TEX_HELP, systemFallbackNote, systemTexAdvice } from './engine/systemTex.js';
import { blockedToolHelp } from './engine/compileLog.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Read the version rather than restating it. Hardcoded, it sat at 0.0.1 through
// every release — so the one place a user could check what they were running
// reported a version that never shipped on npm. The install line is
// `npx -y texchronicle` with no pin, and npx caches, which makes "did my update
// actually take effect?" a question worth being able to answer.
const { version } = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { version: string };

// The Node floor is checked in bin/cli.mjs, not here. A check briefly lived in
// this file and was removed: it sat in the module body, which ESM evaluates
// AFTER every `import` above it, so on the old Node it targeted chokidar or
// playwright threw first and it never printed. It could only fire when every
// dependency loaded cleanly — precisely when it was not needed.

const server = new McpServer({ name: 'texchronicle', version });
// The React workspace is the primary UI; fall back to the legacy /viewer only
// when ui/dist hasn't been built (e.g. a fresh clone before `npm run build:ui`).
const hasWorkspace = existsSync(join(PKG_ROOT, 'ui', 'dist', 'index.html'));

let viewerOpened = false;
// One-shot: the no-git note is worth saying, once.
let historyWarned = false;


server.registerTool(RENDER_PREVIEW_NAME, renderPreviewConfig, async ({ mainFile, engine, backend, shellEscape }) => {
  const projectRoot = process.cwd();
  try {
    const preview = await getPreview();
    setConfig({ projectRoot, mainFile, engine: engine as Engine | undefined, backend: backend as Backend | undefined, shellEscape: shellEscape as boolean | undefined });
    startWatching(projectRoot); // passive live-reload for saves between tool calls

    const result = await requestCompile();

    const workspaceUrl = hasWorkspace ? `${preview.url}/app` : preview.viewerUrl;
    // Open the workspace tab once per server lifetime.
    if (!viewerOpened) { viewerOpened = true; open(workspaceUrl).catch(() => {}); }

    if (result.success) {
      const truncNote = result.truncated ? ' (note: project too large — some files were skipped)' : '';
      const errs = result.verdict?.errors.length ?? 0;
      // Say "with errors" when there were some. Reporting a clean ✓ over a
      // paper LaTeX only half-typeset is how a truncated PDF quietly replaced a
      // good one, and how Claude was told to stop looking for the problem.
      const head = errs
        ? `⚠ Compiled ${result.mainFile} WITH ${errs} error${errs > 1 ? 's' : ''} (${result.engine} · ${result.backend}, ${result.ms}ms). LaTeX stopped part way, so this run's PDF is truncated — the preview still shows your last clean render. Fix the errors below and it will update.`
        : `✓ Compiled ${result.mainFile} with ${result.engine} · ${result.backend} in ${result.ms}ms — ${result.fileCount} files${truncNote}.`;

      const notes: string[] = [];
      // Said once, on the first compile that cannot be recorded. Someone letting
      // an agent edit their paper should know there is no record of it — but
      // repeating it every compile turns it into noise, and noise is what teaches
      // people to skim past the notes that do matter.
      const history = await historyStatus(projectRoot);
      if (!historyWarned && history.mode !== 'project' && history.mode !== 'shadow') {
        historyWarned = true;
        const why = history.mode === 'no-git'
          ? 'no `git` was found on PATH. Install it from https://git-scm.com/ and restart — no account or remote is involved; the history stays on this machine.'
          // Naming the path and the OS error is the whole point: a permissions
          // problem and a full disk need different things from the reader, and
          // "install git" answers neither.
          : `TeXChronicle couldn't create its history store — ${history.detail ?? 'unknown error'}. git itself is fine.`;
        notes.push(`Change history is off: ${why} Edits aren't being recorded and you can't diff or roll back. Everything else works.`);
      }
      // Say it first: this PDF came off a different toolchain than the one the
      // machine is set up for, and that is the single most important thing about
      // it. Left unsaid, a broken local TeX reads as a clean success.
      if (result.systemFallback) {
        notes.push(systemFallbackNote(result.systemFallback));
      }
      if (result.stubbedPackages?.length) {
        notes.push(
          `Stubbed out ${result.stubbedPackages.map((p) => `\\usepackage{${p}}`).join(', ')} — not in the bundled TeX Live and unused here, so it no longer blocks the compile.`,
        );
      }
      if (errs) {
        notes.push(summarizeErrors(result.log || ''));
        // Only worth saying when system isn't what already ran — under the
        // 'auto' default a local TeX is picked up on its own, so anyone seeing
        // this has no local TeX at all. "Retry with backend: system if you have
        // one" was a dead end for exactly the people who read it.
        if (result.backend !== 'system') {
          notes.push(`These packages come from the bundled WASM TeX Live, which is a subset. For output that matches Overleaf, TeXChronicle will use a local TeX install automatically once there is one.\n\n${INSTALL_TEX_HELP}`);
        }
      }

      return {
        content: [{
          type: 'text',
          text: `${head}${notes.length ? '\n\n' + notes.join('\n\n') : ''}\n\nWorkspace (live preview, source editor, history, PDF comments — auto-reloads on edits): ${workspaceUrl}`,
        }],
      };
    }

    // Compile failed — return parsed errors so Claude can self-correct.
    const blockedTools = result.verdict?.blockedTools ?? [];
    const toolHint = blockedTools.length
      ? `\n\n${blockedToolHelp(blockedTools, result.backend, shellEscape === true)}`
      : '';
    const missingCls = result.verdict?.missingClasses ?? [];
    const clsHint = missingCls.length
      ? `\n\nThe document class ${missingCls.map((c) => `\`${c}.cls\``).join(', ')} is not in the bundled TeX Live subset, and a class cannot be stubbed the way an unused package can. Put the .cls next to the source — for a conference paper it comes with the author kit, and Overleaf projects can download it.${result.backend === 'system' ? '' : `\n\nA local TeX install would also have it, and TeXChronicle picks one up automatically.\n\n${INSTALL_TEX_HELP}`}`
      : '';
    // A package the source really uses is deliberately never stubbed — but until
    // now that left the reader with a raw log line and nothing else. `newtxmath
    // is required` told one user nothing about why, or that the bundled engine
    // could not ever supply it, so an agent went and installed a whole TeX
    // distribution to find out. Say the three things that actually decide what
    // they do next: what is missing, that the bundled subset cannot provide it,
    // and what the local-TeX situation on this machine really is.
    const missingPkgs = (result.verdict?.missingPackages ?? []).filter((p) => !missingCls.includes(p));
    const pkgHint = missingPkgs.length && result.backend !== 'system'
      ? `\n\n${missingPkgs.map((p) => `\`${p}\``).join(', ')} ${missingPkgs.length > 1 ? 'are' : 'is'} not in the bundled TeX Live subset, and the source really uses ${missingPkgs.length > 1 ? 'them' : 'it'} — so ${missingPkgs.length > 1 ? 'they cannot' : 'it cannot'} be stubbed out without rendering something different from what you wrote.\n\n${systemTexAdvice(result.systemTex, { packages: missingPkgs, fallback: result.systemFallback })}`
      : '';
    return {
      isError: true,
      content: [{ type: 'text', text: `✖ Compile of ${result.mainFile} failed (${result.engine}).\n\n${summarizeErrors(result.log || result.error || '')}${toolHint}${clsHint}${pkgHint}` }],
    };
  } catch (err) {
    const msg = err instanceof MainFileError ? err.message : String((err as Error).message ?? err);
    return { isError: true, content: [{ type: 'text', text: `✖ ${msg}` }] };
  }
});

server.registerTool(SHOW_DIFF_NAME, showDiffConfig, async ({ checkpoint }) => {
  const projectRoot = process.cwd();
  setProjectRoot(projectRoot); // the diff endpoints read this
  try {
    await getPreview(); // ensure the preview server + headless browser are up
    if (!(await canTrackHistory(projectRoot))) {
      return { isError: true, content: [{ type: 'text', text: "✖ History needs git, and none was found on PATH. Install it from https://git-scm.com/ and restart — no account or remote is involved; the history stays on this machine." }] };
    }
    const path = checkpoint ? `/diff-view?sha=${encodeURIComponent(checkpoint)}` : '/diff-view';
    const { empty, png } = await captureDiff(path);
    if (empty || !png) {
      return { content: [{ type: 'text', text: 'No changes to show — the working tree is clean.' }] };
    }
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: checkpoint ? `Side-by-side diff of checkpoint ${checkpoint}.` : 'Side-by-side diff of your current uncommitted changes.' },
      ],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `✖ ${String((err as Error).message)}` }] };
  }
});

server.registerTool(LIST_CHECKPOINTS_NAME, listCheckpointsConfig, async ({ limit }) => {
  const projectRoot = process.cwd();
  setProjectRoot(projectRoot);
  if (!(await canTrackHistory(projectRoot))) {
    return { content: [{ type: 'text', text: "History needs git, and none was found on PATH. Install it from https://git-scm.com/ and restart — no account or remote is involved; the history stays on this machine." }] };
  }
  const all = await listCheckpoints(projectRoot);
  if (!all.length) return { content: [{ type: 'text', text: 'No checkpoints yet.' }] };
  const items = all.slice(0, limit ?? 10);
  const lines = items.map((c) =>
    `${c.sha.slice(0, 10)}  ${c.time}  ${c.filesChanged} file${c.filesChanged === 1 ? '' : 's'} +${c.insertions} -${c.deletions}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
});

server.registerTool(CHECK_COMMENTS_NAME, checkCommentsConfig, async ({ includeResolved }) => {
  const projectRoot = process.cwd();
  setProjectRoot(projectRoot);
  const all = await listComments(projectRoot);
  const accepted = all.filter((c) => c.status === 'accepted');
  const resolved = all.filter((c) => c.status === 'resolved');
  const suggested = all.filter((c) => c.status === 'suggested');
  // Each accepted comment becomes a located work item: the quoted passage, the
  // instruction, and the source file:line it anchors to (best-effort text match).
  const fmtLocated = async (c: (typeof all)[number]) => {
    const anchor = await findAnchor(projectRoot, c.quote);
    const loc = anchor
      ? `\n  ↳ source: ${anchor.file}:${anchor.line}`
      : '\n  ↳ source: not located — search the files for the quoted text';
    const who = c.role && c.role !== 'human' ? ` (${c.role})` : '';
    const thread = c.replies?.length
      ? '\n  ' + c.replies.map((r) => `↪ ${r.by}: ${r.text}`).join('\n  ')
      : '';
    return `[id: ${c.id}]${who} p.${c.page} — "${c.quote.slice(0, 160)}${c.quote.length > 160 ? '…' : ''}"${loc}\n  → ${c.text}${thread}`;
  };
  const fmtPlain = (c: (typeof all)[number]) =>
    `[id: ${c.id}] p.${c.page} — "${c.quote.slice(0, 160)}${c.quote.length > 160 ? '…' : ''}"\n  → ${c.text}` +
    (c.resolvedCheckpoint ? `\n  ✓ resolved at ${c.resolvedCheckpoint.slice(0, 10)}` : '') +
    (c.restoreReview ? `\n  ⚠ verify again: an older ${c.restoreReview.scope} version was restored afterward` : '');
  const awaiting = suggested.length
    ? `\n\n(${suggested.length} reviewer suggestion${suggested.length === 1 ? '' : 's'} still ${suggested.length === 1 ? 'awaits' : 'await'} the human's accept in the workspace — not actionable yet.)`
    : '';
  let text: string;
  if (!accepted.length) {
    text = 'No accepted comments.' + (resolved.length ? ` (${resolved.length} already resolved.)` : '') + awaiting;
  } else {
    const items = (await Promise.all(accepted.map(fmtLocated))).join('\n\n');
    text = `${accepted.length} accepted comment${accepted.length === 1 ? '' : 's'} — edit each at its source location per the instruction, then call ${RESOLVE_COMMENT_NAME} with its id and a one-line note:\n\n${items}${awaiting}`;
  }
  if (includeResolved && resolved.length) {
    text += `\n\nResolved:\n${resolved.map(fmtPlain).join('\n\n')}`;
  }
  return { content: [{ type: 'text', text }] };
});

server.registerTool(RESOLVE_COMMENT_NAME, resolveCommentConfig, async ({ id, note }) => {
  const projectRoot = process.cwd();
  setProjectRoot(projectRoot);
  const current = await matchingCheckpointSha(projectRoot);
  const shown = peekPreview()?.renderState();
  if (!current.sha || current.dirty || (shown && (shown.status !== 'ok' || shown.checkpoint !== current.sha))) {
    return {
      isError: true,
      content: [{ type: 'text', text: '✖ This source is not the latest successful checkpoint yet. Wait for the current compile (or fix its error), then resolve the comment so its resolution is linked to the version that actually rendered.' }],
    };
  }
  const updated = await updateComment(projectRoot, id, {
    status: 'resolved',
    resolvedNote: note,
    resolvedCheckpoint: current.sha,
  });
  if (!updated) {
    return { isError: true, content: [{ type: 'text', text: `✖ Unknown comment id: ${id}` }] };
  }
  // Best-effort live nudge — only if a viewer is already up; never cold-start
  // the engine just to broadcast (keeps the loop's resolve calls instant).
  try { peekPreview()?.broadcast({ type: 'comments-changed' }); } catch { /* no viewer */ }
  return { content: [{ type: 'text', text: `✓ Resolved comment ${id} ("${updated.quote.slice(0, 60)}…") — the card now shows: ${note}` }] };
});

server.registerTool(ADD_COMMENT_NAME, addCommentConfig, async ({ quote, comment, role, page, accepted }) => {
  const projectRoot = process.cwd();
  setProjectRoot(projectRoot);
  const anchor = await findAnchor(projectRoot, quote).catch(() => null);
  const created = await addComment(projectRoot, {
    page: page ?? 1,
    quote,
    rects: [], // the workspace re-anchors these comments to the PDF by text
    text: comment,
    role: role ?? 'reviewer',
    status: accepted ? 'accepted' : 'suggested',
    createdCheckpoint: await latestCheckpointSha(projectRoot),
    ...(anchor ? { sourceFile: anchor.file, sourceLine: anchor.line } : {}),
  });
  try { peekPreview()?.broadcast({ type: 'comments-changed' }); } catch { /* no viewer */ }
  const where = accepted
    ? 'It is actionable now (autonomous mode).'
    : 'It is a suggestion — the human accepts it in the workspace before the loop acts on it.';
  return { content: [{ type: 'text', text: `✓ ${role ?? 'reviewer'} comment ${created.id} posted on "${quote.slice(0, 60)}${quote.length > 60 ? '…' : ''}". ${where}` }] };
});

server.registerTool(REPLY_COMMENT_NAME, replyCommentConfig, async ({ id, text, role }) => {
  const projectRoot = process.cwd();
  setProjectRoot(projectRoot);
  const updated = await addReply(projectRoot, id, { by: role ?? 'author', text });
  if (!updated) return { isError: true, content: [{ type: 'text', text: `✖ Unknown comment id: ${id}` }] };
  try { peekPreview()?.broadcast({ type: 'comments-changed' }); } catch { /* no viewer */ }
  return { content: [{ type: 'text', text: `✓ Replied on comment ${id} (${updated.replies?.length ?? 1} message${(updated.replies?.length ?? 1) === 1 ? '' : 's'} in thread).` }] };
});

// (add_comment and reply_to_comment are registered above.)

// Clean shutdown. Until this existed, nothing was released on exit: Chromium,
// the preview server, its WebSockets and the chokidar watcher were all left to
// whatever the OS did — and when the process was NOT reaped, to nothing. A
// leaked server keeps watching the project and recompiling on every save,
// competing with the live one for CPU while holding a headless Chromium with the
// WASM TeX Live image resident. That is not hypothetical: twelve orphaned
// servers accumulated in this repo's own CI and starved a later phase into a
// fifteen-minute timeout.
//
// The install line is `npx -y texchronicle`, and killing npx does not reliably
// kill the node grandchild, which is what makes handlers here worth having
// rather than relying on process teardown.
// The whole teardown has to fit inside the client's fuse: StdioClientTransport
// does stdin.end() → 2s → SIGTERM → 2s → SIGKILL. Past that we are killed
// holding everything, so releasing most of it in time beats releasing all of it
// too late.
const SHUTDOWN_BUDGET_MS = 3000;

// Cached, not a boolean. A `if (shuttingDown) return` guard made the SECOND
// caller resolve immediately — and since each caller then runs process.exit(0),
// the second signal killed the process while the first teardown was still inside
// browser.close(). The disconnect above sends stdin-close and SIGTERM two
// seconds apart every time, so that was the normal path, not an edge case.
// Returning the in-flight promise makes every caller wait for the same work.
let shutdownRun: Promise<void> | null = null;

function shutdown(why: string): Promise<void> {
  shutdownRun ??= (async () => {
    console.error(`[texchronicle] shutting down (${why})`);
    // Watcher first: it can start a compile, and a compile started now would
    // keep the engine alive past the teardown that is about to close it.
    await stopWatching().catch(() => {});
    await shutdownEngine().catch(() => {});
  })();
  return shutdownRun;
}

/** Tear down within the budget, then exit regardless. */
function shutdownAndExit(why: string, code = 0): void {
  const bail = new Promise<void>((r) => setTimeout(() => {
    console.error(`[texchronicle] shutdown exceeded ${SHUTDOWN_BUDGET_MS}ms — exiting anyway`);
    r();
  }, SHUTDOWN_BUDGET_MS).unref());
  void Promise.race([shutdown(why), bail]).then(() => process.exit(code));
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => shutdownAndExit(sig));
}
// The client going away closes stdio. On Windows that arrives with no signal at
// all, so a signal handler alone would leave the process running with the parent
// gone — exactly the orphan this is meant to prevent.
process.stdin.on('close', () => shutdownAndExit('stdio closed'));
// There is deliberately no `beforeExit` handler. It does not fire on an explicit
// process.exit(), and running the teardown there without exiting left the
// shutdown latched while the loop kept turning — so anything a later compile
// rebuilt could never be torn down again.

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[texchronicle] ready on stdio');
