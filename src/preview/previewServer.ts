// One local HTTP + WebSocket server, two roles:
//   - engine host: /host.html + /engine/* (texlyre-busytex dist) + /busytex/*
//     (WASM assets) for the HIDDEN headless-Chromium page that runs the compiler.
//   - viewer: /viewer (pdf.js page) + /pdfjs/* + /latest.pdf + a WS channel that
//     pushes reload/compiling/error events to the human's open tab.
// COOP/COEP headers are set on everything — the engine's Worker/SharedArrayBuffer
// need cross-origin isolation (spike finding).
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { refuseReason, allowWebSocket } from './originGuard.js';
import { hostPageHtml } from '../engine/hostPage.js';
import { viewerPageHtml } from './viewerPage.js';
import { diffViewHtml } from './diffViewPage.js';
import { canTrackHistory, historyStatus, listCheckpoints, getCheckpointDiff, getWorkingDiff, restoreCheckpoint, restoreFile, latestCheckpointSha, matchingCheckpointSha } from '../git/checkpoints.js';
import { listSectionHistory, getSectionDiff, restoreSection } from '../git/sectionHistory.js';
import { readRenderArtifact } from '../git/renderArtifacts.js';
import { listTextFiles, readTextFile, writeTextFile, listTree, createTextFile, createDir, renameEntry, deleteEntry, writeUpload, resolveAssetFile, resolveIncludeFile } from './filesApi.js';
import { suppressNextChange } from '../watch/fileWatcher.js';
import { listComments, addComment, updateComment, deleteComment, addReply, markCommentsForRestoreReview, type RestoreScope } from './commentsStore.js';
import { getGitHubRemote } from '../git/remote.js';
import { buildOverleafZip } from '../export/overleafZip.js';
import { resolveMainFile } from '../project/resolveMainFile.js';
import { getProjectRoot } from '../session.js';
import { busytexDir } from '../engine/assetsDir.js';

/** A restore intentionally leaves the independent comment store alone. When it
 * targets a checkpoint older than a comment's resolution, mark that card for
 * verification: the old source may have brought the original problem back. */
async function flagCommentsAfterOlderRestore(
  root: string,
  checkpoint: string,
  scope: RestoreScope,
  label?: string,
): Promise<number> {
  const [history, comments] = await Promise.all([listCheckpoints(root), listComments(root)]);
  const position = new Map(history.map((item, index) => [item.sha, index]));
  const restoredAt = position.get(checkpoint);
  if (restoredAt === undefined) return 0;
  const ids = comments
    .filter((comment) => {
      if (comment.status !== 'resolved' || !comment.resolvedCheckpoint) return false;
      const resolvedAt = position.get(comment.resolvedCheckpoint);
      return resolvedAt !== undefined && resolvedAt < restoredAt;
    })
    .map((comment) => comment.id);
  return markCommentsForRestoreReview(root, ids, {
    checkpoint,
    scope,
    ...(label ? { label } : {}),
    at: new Date().toISOString(),
  });
}
import { inverseSyncTeX } from './synctex.js';

const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Locate a dependency's install directory via Node's OWN resolver rather than
// assuming `<pkg-root>/node_modules/<dep>`. When MagicTeX is installed from npm,
// npm hoists dependencies to the CONSUMER's top-level node_modules, so that
// assumed path doesn't exist and every asset below 404s — which silently breaks
// the compile engine, since the engine only loads on the first render_preview.
// It only looked fine in development because a cloned repo does have its own
// node_modules. Resolving `<dep>/package.json` walks the real lookup chain, so
// it works hoisted, nested, or linked.
const require = createRequire(import.meta.url);
function depDir(pkg: string): string {
  return dirname(require.resolve(`${pkg}/package.json`));
}

const ENGINE_DIST = join(depDir('texlyre-busytex'), 'dist');
const PDFJS_ROOT = depDir('pdfjs-dist');
const DIFF2HTML_ROOT = join(depDir('diff2html'), 'bundles');
const UI_DIST = join(PKG_ROOT, 'ui', 'dist');

// Shutdown budget. The MCP client's disconnect is stdin.end() → 2s → SIGTERM →
// 2s → SIGKILL, so everything here has to finish inside a few seconds or it may
// as well not run. Long enough for a localhost socket to flush a small frame;
// short enough that a wedged one costs nothing.
const GOODBYE_FLUSH_MS = 250;
const CLOSE_DEADLINE_MS = 1500;

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.json': 'application/json', '.txt': 'text/plain', '.pdf': 'application/pdf',
  '.map': 'application/json', '.css': 'text/css',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.eps': 'application/postscript',
};

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/**
 * Serve a file from one of our own asset directories.
 *
 * Both sides get resolved, and the comparison includes the separator. The old
 * `normalize(join(root, rel)).startsWith(root)` got both halves wrong.
 *
 * **The root was never normalised.** `join`/`normalize` return the platform
 * separator, so on Windows `filePath` came back with backslashes while `root`
 * stayed exactly as the caller had it. For `MAGICTEX_ASSETS_DIR` that is a path
 * a human typed — usually into a JSON config, where a backslash has to be
 * doubled and a forward slash does not:
 *
 *   root     C:/Users/Zoe Lin/…/assets/busytex
 *   filePath C:\Users\Zoe Lin\…\assets\busytex\busytex.wasm     -> 403
 *
 * Every engine asset 403'd, and what the user saw was "BusyTeX worker failed to
 * initialize", with nothing pointing at the setting they had just added.
 *
 * **A prefix match is not containment.** `C:\Users\zoe\project-elsewhere\x.tex`
 * starts with `C:\Users\zoe\proj`. Not reachable today, since serveFrom is only
 * ever handed our own directories — but it is the same line, and `filesApi`'s
 * guard has carried both halves since the server was hardened.
 */
async function serveFrom(root: string, rel: string, res: ServerResponse) {
  const base = resolve(root);
  const filePath = resolve(base, rel);
  if (filePath !== base && !filePath.startsWith(base + sep)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(filePath);
    // HTML must never be cached: after a UI rebuild the old hashed chunks are
    // gone, and a cached index.html pointing at them renders a blank page.
    // Hashed assets are immutable by construction, so they can cache forever.
    const ext = extname(filePath);
    const cache = ext === '.html'
      ? 'no-store'
      : /[-.][A-Za-z0-9_-]{8,}\.(js|css|mjs)$/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, ...ISOLATION_HEADERS });
    res.end(body);
  } catch {
    res.writeHead(404, ISOLATION_HEADERS).end('not found');
  }
}

export interface PreviewServerHandle {
  server: Server;
  port: number;
  url: string;
  viewerUrl: string;
  /** Replace the current PDF and notify viewers to re-render. `name` is the
   *  source main-file (e.g. "main.tex") used for the download filename. */
  setLatestPdf: (pdf: Uint8Array, name?: string, syncTex?: Uint8Array) => Promise<void>;
  /** Tell viewers a compile is running / failed, or that comments changed. */
  broadcast: (msg: { type: 'compiling' } | { type: 'compile-error'; log: string } | { type: 'comments-changed' }) => void;
  /** Say goodbye to open tabs, drop every socket, and stop listening. */
  close: () => Promise<void>;
}

export function startPreviewServer(): Promise<PreviewServerHandle> {
  let latestPdf: Buffer | null = null;
  let latestName: string | undefined;
  // The published PDF and map are kept as a matched pair. Two alternating slots
  // let the next compile finish writing off to the side before queries switch to
  // it, so a click can never observe half of one render and half of another.
  let latestSyncPdf: string | null = null;
  let syncSlot = 0;
  const clients = new Set<WebSocket>();

  const send = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) { try { ws.send(data); } catch { /* dropped */ } }
  };

  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
    res.end(JSON.stringify(body));
  };

  // Set once listen() has assigned a port; the guard needs it to recognise its
  // own origin, and every request arrives after that.
  let boundPort = 0;

  const server = createServer(async (req, res) => {
    // Before anything is read or written. This server is reachable from every
    // web page the user visits, because localhost is reachable from every
    // origin — see originGuard.ts for what that allowed.
    const refuse = refuseReason(req, boundPort);
    if (refuse) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...ISOLATION_HEADERS });
      res.end(`MagicTeX refused this request: ${refuse}
`);
      return;
    }

    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(reqUrl.pathname);

    // Git history endpoints — read-only, over the current project root (the same
    // repo the coordinator checkpoints; git resolves the enclosing repo from there).
    if (pathname === '/git/status') { return json(res, { isRepo: await canTrackHistory(getProjectRoot()), ...(await historyStatus(getProjectRoot())) }); }
    if (pathname === '/git/checkpoints') { return json(res, await listCheckpoints(getProjectRoot())); }
    if (pathname === '/git/diff') {
      const sha = reqUrl.searchParams.get('sha') ?? '';
      try {
        const diff = await getCheckpointDiff(getProjectRoot(), sha);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
        res.end(diff); return;
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }
    // Semantic history: the same checkpoint chain, projected into section and
    // subsection identities. No separate source archive is created.
    if (pathname === '/git/sections') {
      try { return json(res, await listSectionHistory(getProjectRoot())); }
      catch (e) { res.writeHead(500, ISOLATION_HEADERS).end(String((e as Error).message)); return; }
    }
    if (pathname === '/git/section-diff') {
      const sha = reqUrl.searchParams.get('sha') ?? '';
      const section = reqUrl.searchParams.get('section') ?? '';
      const subtree = reqUrl.searchParams.get('subtree') === '1';
      try { return json(res, await getSectionDiff(getProjectRoot(), section, sha, subtree)); }
      catch (e) { res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return; }
    }
    if (pathname === '/git/restore-section' && req.method === 'POST') {
      const sha = reqUrl.searchParams.get('sha') ?? '';
      const section = reqUrl.searchParams.get('section') ?? '';
      try {
        const root = getProjectRoot();
        const restored = await restoreSection(root, section, sha);
        const marked = await flagCommentsAfterOlderRestore(root, sha, 'section', section);
        if (marked) send({ type: 'comments-changed' });
        const { requestCompile } = await import('../coordinator.js');
        requestCompile().catch(() => {});
        return json(res, { ok: true, ...restored });
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }
    // Exact historical render for a checkpoint. Older checkpoints created
    // before render artifacts were introduced simply return 404; their source
    // history and diffs remain available.
    if (pathname === '/git/render') {
      const sha = reqUrl.searchParams.get('sha') ?? '';
      try {
        const pdf = await readRenderArtifact(getProjectRoot(), sha);
        if (!pdf) { res.writeHead(404, ISOLATION_HEADERS).end('no stored PDF for this checkpoint'); return; }
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
        res.end(pdf); return;
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }
    // Restore the working tree to a checkpoint (revert), then recompile.
    if (pathname === '/git/restore' && req.method === 'POST') {
      const sha = reqUrl.searchParams.get('sha') ?? '';
      try {
        const root = getProjectRoot();
        await restoreCheckpoint(root, sha);
        const marked = await flagCommentsAfterOlderRestore(root, sha, 'project');
        if (marked) send({ type: 'comments-changed' });
        const { requestCompile } = await import('../coordinator.js');
        requestCompile().catch(() => {});
        return json(res, { ok: true });
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }
    // Restore a single file to a checkpoint version (per-file revert).
    if (pathname === '/git/restore-file' && req.method === 'POST') {
      const sha = reqUrl.searchParams.get('sha') ?? '';
      const path = reqUrl.searchParams.get('path') ?? '';
      try {
        const root = getProjectRoot();
        await restoreFile(root, sha, path);
        const marked = await flagCommentsAfterOlderRestore(root, sha, 'file', path);
        if (marked) send({ type: 'comments-changed' });
        const { requestCompile } = await import('../coordinator.js');
        requestCompile().catch(() => {});
        return json(res, { ok: true });
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }

    // Anchored comments API. Mutations broadcast comments-changed so every open
    // workspace tab (and the Claude-side tools) stay in sync.
    if (pathname === '/api/comments') {
      const root = getProjectRoot();
      try {
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const created = await addComment(root, {
            ...input,
            createdCheckpoint: await latestCheckpointSha(root),
          });
          send({ type: 'comments-changed' });
          return json(res, created);
        }
        if (req.method === 'PATCH') {
          const id = reqUrl.searchParams.get('id') ?? '';
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          // Checkpoint ids are server-derived, never accepted from browser JSON.
          const patch = {
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.text !== undefined ? { text: input.text } : {}),
            ...(input.resolvedNote !== undefined ? { resolvedNote: input.resolvedNote } : {}),
            ...(input.restoreReview === null ? { restoreReview: null } : {}),
          };
          if (input.status === 'resolved') {
            const current = await matchingCheckpointSha(root);
            if (current.sha) Object.assign(patch, { resolvedCheckpoint: current.sha });
          }
          const updated = await updateComment(root, id, patch);
          if (!updated) { res.writeHead(404, ISOLATION_HEADERS).end('unknown comment'); return; }
          send({ type: 'comments-changed' });
          return json(res, updated);
        }
        if (req.method === 'DELETE') {
          const id = reqUrl.searchParams.get('id') ?? '';
          const ok = await deleteComment(root, id);
          // 404 like PATCH and /reply above, rather than 200 with ok:false — a
          // caller checking res.ok would otherwise read a no-op as a success.
          // Broadcasting only on a real deletion also spares every connected
          // client a refetch when several agents are working at once.
          if (!ok) { res.writeHead(404, ISOLATION_HEADERS).end('unknown comment'); return; }
          send({ type: 'comments-changed' });
          return json(res, { ok });
        }
        return json(res, await listComments(root));
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }

    // Post a reply into a comment's thread (the human's reply from the panel).
    if (pathname === '/api/comments/reply' && req.method === 'POST') {
      const root = getProjectRoot();
      const id = reqUrl.searchParams.get('id') ?? '';
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const { text, by } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const updated = await addReply(root, id, { by: by ?? 'human', text });
        if (!updated) { res.writeHead(404, ISOLATION_HEADERS).end('unknown comment'); return; }
        send({ type: 'comments-changed' });
        return json(res, updated);
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }

    // Source-panel file API (list / read / write project text files).
    if (pathname === '/api/files') {
      try { return json(res, await listTextFiles(getProjectRoot())); }
      catch (e) { res.writeHead(500, ISOLATION_HEADERS).end(String((e as Error).message)); return; }
    }

    // PDF -> source using the genuine map produced by the system TeX backend.
    // The browser supplies 72-dpi page coordinates with a top-left origin, the
    // native convention of `synctex edit`. WASM and historical PDFs have no map;
    // the UI retains its text-based fallback for those cases.
    if (pathname === '/api/synctex/inverse') {
      const page = Number(reqUrl.searchParams.get('page'));
      const x = Number(reqUrl.searchParams.get('x'));
      const y = Number(reqUrl.searchParams.get('y'));
      if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        res.writeHead(400, ISOLATION_HEADERS).end('invalid SyncTeX point'); return;
      }
      const pdf = latestSyncPdf;
      if (!pdf) return json(res, { available: false });
      const location = await inverseSyncTeX(getProjectRoot(), pdf, page, x, y);
      return json(res, location ? { available: true, ...location } : { available: false });
    }

    // File tree (folders + editable files) for the Overleaf-style panel.
    if (pathname === '/api/tree') {
      try { return json(res, await listTree(getProjectRoot())); }
      catch (e) { res.writeHead(500, ISOLATION_HEADERS).end(String((e as Error).message)); return; }
    }

    // Read-only TeX included by the Live document model. Generated tables often
    // live in a sibling `tables` directory outside the launched draft folder;
    // resolve them within the enclosing Git work tree without making them
    // writable through the browser editor.
    if (pathname === '/api/include') {
      if (req.method !== 'GET') { res.writeHead(405, ISOLATION_HEADERS).end('method not allowed'); return; }
      try {
        const include = await resolveIncludeFile(getProjectRoot(), reqUrl.searchParams.get('path') ?? '');
        return json(res, {
          path: include.relativePath,
          content: await readFile(include.fullPath, 'utf8'),
          editable: include.editable,
        });
      } catch (e) {
        res.writeHead(404, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }

    // Read-only project artwork for Live figures and file-tree previews. This
    // deliberately has its own guarded route rather than reusing /api/file,
    // whose text-only contract is what prevents the editor from decoding an
    // arbitrary binary file as UTF-8. SVG is sandboxed when navigated directly;
    // in the UI it is loaded as an image, where scripts do not execute.
    if (pathname === '/api/asset') {
      if (req.method !== 'GET') { res.writeHead(405, ISOLATION_HEADERS).end('method not allowed'); return; }
      try {
        const asset = await resolveAssetFile(
          getProjectRoot(),
          reqUrl.searchParams.get('path') ?? '',
          reqUrl.searchParams.get('from') ?? undefined,
        );
        const body = await readFile(asset.fullPath);
        const extension = extname(asset.fullPath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[extension] || 'application/octet-stream',
          'Content-Length': String(body.length),
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(asset.relativePath))}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
          ...ISOLATION_HEADERS,
        });
        res.end(body); return;
      } catch (e) {
        res.writeHead(404, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }

    // Upload a figure/asset: raw binary body, target path in ?path=.
    if (pathname === '/api/upload' && req.method === 'POST') {
      const rel = reqUrl.searchParams.get('path') ?? '';
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        suppressNextChange(join(getProjectRoot(), rel)); // don't auto-recompile on upload
        await writeUpload(getProjectRoot(), rel, Buffer.concat(chunks));
        return json(res, { ok: true });
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }

    // File-system mutations: new file / new folder / rename / delete.
    if (pathname === '/api/fs' && req.method === 'POST') {
      const root = getProjectRoot();
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const { op, path: rel, to } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (op === 'mkfile') await createTextFile(root, rel);
        else if (op === 'mkdir') await createDir(root, rel);
        else if (op === 'rename') await renameEntry(root, rel, to);
        else if (op === 'delete') await deleteEntry(root, rel);
        else throw new Error('unknown op');
        return json(res, { ok: true });
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }
    if (pathname === '/api/file') {
      const rel = reqUrl.searchParams.get('path') ?? '';
      try {
        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          // Suppress the watcher for our own write, then recompile only when the
          // caller asked (?compile=1 — Ctrl+S / Save). A bare save doesn't compile.
          suppressNextChange(join(getProjectRoot(), rel));
          await writeTextFile(getProjectRoot(), rel, Buffer.concat(chunks).toString('utf8'));
          if (reqUrl.searchParams.get('compile') === '1') {
            const { requestCompile } = await import('../coordinator.js');
            requestCompile().catch(() => {});
          }
          return json(res, { ok: true });
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
        res.end(await readTextFile(getProjectRoot(), rel)); return;
      } catch (e) {
        res.writeHead(400, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }

    // Manual recompile (the toolbar's "Recompile" button). Imported lazily to
    // avoid a static import cycle with the coordinator (which holds this server).
    if (pathname === '/api/recompile' && req.method === 'POST') {
      try {
        const { requestCompile } = await import('../coordinator.js');
        const r = await requestCompile();
        return json(res, { ok: r.success });
      } catch (e) {
        res.writeHead(500, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }

    // Overleaf export — a clean upload zip (build inputs only).
    if (pathname === '/export.zip') {
      try {
        const { buffer, filename } = await buildOverleafZip(getProjectRoot());
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store', ...ISOLATION_HEADERS,
        });
        res.end(buffer); return;
      } catch (e) {
        res.writeHead(500, ISOLATION_HEADERS).end(String((e as Error).message)); return;
      }
    }
    // One-click "Open in Overleaf" link — only when the repo has a GitHub origin
    // (Overleaf fetches its public archive zip). null otherwise.
    if (pathname === '/overleaf/link') {
      const root = getProjectRoot();
      const gh = await getGitHubRemote(root);
      if (!gh) return json(res, { url: null });
      let main = 'main.tex';
      try { main = await resolveMainFile(root); } catch { /* fall back */ }
      const archive = `https://github.com/${gh.owner}/${gh.repo}/archive/refs/heads/${gh.branch}.zip`;
      const url = `https://www.overleaf.com/docs?snip_uri=${encodeURIComponent(archive)}&main_document=${encodeURIComponent(main)}`;
      return json(res, { url });
    }

    if (pathname === '/' || pathname === '/host.html') {
      res.writeHead(200, { 'Content-Type': 'text/html', ...ISOLATION_HEADERS }); res.end(hostPageHtml()); return;
    }
    if (pathname === '/viewer') {
      res.writeHead(200, { 'Content-Type': 'text/html', ...ISOLATION_HEADERS }); res.end(viewerPageHtml()); return;
    }
    // Side-by-side diff page — screenshotted by the show_diff tool. `sha` selects a
    // checkpoint; omitted = current uncommitted changes.
    if (pathname === '/diff-view') {
      const root = getProjectRoot();
      const sha = reqUrl.searchParams.get('sha');
      let diff = '';
      try { diff = sha ? await getCheckpointDiff(root, sha) : await getWorkingDiff(root); } catch { /* empty */ }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
      res.end(diffViewHtml(diff)); return;
    }
    if (pathname === '/latest.pdf') {
      if (!latestPdf) { res.writeHead(404, ISOLATION_HEADERS).end('no pdf yet'); return; }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
      res.end(latestPdf); return;
    }
    if (pathname.startsWith('/engine/')) return serveFrom(ENGINE_DIST, pathname.slice('/engine/'.length), res);
    // Resolved per request through the same helper the downloader writes with,
    // so serving and fetching can't disagree about where the engine lives — and
    // because on a first run the directory appears partway through the process.
    if (pathname.startsWith('/busytex/')) return serveFrom(busytexDir(), pathname.slice('/busytex/'.length), res);
    if (pathname.startsWith('/pdfjs/')) return serveFrom(PDFJS_ROOT, pathname.slice('/pdfjs/'.length), res);
    if (pathname.startsWith('/diff2html/')) return serveFrom(DIFF2HTML_ROOT, pathname.slice('/diff2html/'.length), res);
    // The React workspace (built by `npm run build:ui` into ui/dist).
    if (pathname === '/app' || pathname === '/app/') return serveFrom(UI_DIST, 'index.html', res);
    if (pathname.startsWith('/app/')) return serveFrom(UI_DIST, pathname.slice('/app/'.length), res);

    res.writeHead(404, ISOLATION_HEADERS).end('not found');
  });

  const wss = new WebSocketServer({
    server,
    // Handshakes are exempt from the same-origin policy, so without this any
    // page can connect, confirm the port, and watch the compile stream.
    verifyClient: (info: { origin?: string }) => allowWebSocket(info.origin, boundPort),
  });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    // A viewer that connects after a compile already ran still needs the current
    // PDF and its name (for the download filename) — push it immediately.
    if (latestPdf) { try { ws.send(JSON.stringify({ type: 'reload', name: latestName })); } catch { /* dropped */ } }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      boundPort = port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        server, port, url, viewerUrl: `${url}/viewer`,
        setLatestPdf: async (pdf, name, syncTex) => {
          latestPdf = Buffer.from(pdf);
          latestName = name;
          latestSyncPdf = null;
          if (name && syncTex?.length) {
            try {
              const nextSlot = syncSlot === 1 ? 2 : 1;
              const dir = join(getProjectRoot(), '.latex-preview', 'synctex', String(nextSlot));
              await mkdir(dir, { recursive: true });
              const stem = basename(name).replace(/\.tex$/i, '') || 'preview';
              const pdfPath = join(dir, stem + '.pdf');
              // Write the inactive slot completely, then switch the pointer.
              await Promise.all([
                writeFile(pdfPath, latestPdf),
                writeFile(join(dir, stem + '.synctex.gz'), syncTex),
              ]);
              syncSlot = nextSlot;
              latestSyncPdf = pdfPath;
            } catch (error) {
              // Mapping is an enhancement, never a reason to hide a good PDF.
              console.warn('[MagicTeX] could not publish SyncTeX data; using text matching', error);
            }
          }
          send({ type: 'reload', name });
        },
        broadcast: (msg) => send(msg),
        close: () => new Promise<void>((done) => {
          // Measured, on the version this replaces: with one WebSocket peer that
          // never answered a close frame, close() took 30 015 ms — the ws
          // library's closeTimeout — and an HTTP request sent one second in was
          // still answered with 200. Both are fatal here, because the MCP client
          // disconnects with stdin.end() → 2 s → SIGTERM → 2 s → SIGKILL: the
          // process dies at ~4 s still holding Chromium and the port, which is
          // the leak this whole path exists to prevent.
          //
          // Three things were wrong and all three are fixed below.

          let settled = false;
          const finish = () => { if (!settled) { settled = true; done(); } };

          // 1. Stop listening FIRST. Previously server.close() ran only inside
          //    wss.close()'s callback, so the port kept accepting for the whole
          //    WebSocket drain — and anything that connected in that window was
          //    then something server.close() had to wait for, unboundedly.
          server.close(finish);
          server.closeAllConnections?.();

          // 2. Say goodbye, and wait for it to reach the wire rather than
          //    guessing. This is the only thing that lets a stale window know it
          //    is stale, so it is worth the few milliseconds — but not worth
          //    blocking shutdown on a peer that has stopped reading.
          let pending = clients.size;
          const cutSockets = () => {
            // terminate(), not close(): close() starts a handshake and waits for
            // a reply that a suspended tab or a half-open TCP connection will
            // never send. The goodbye has already been flushed (or timed out).
            for (const ws of clients) { try { ws.terminate(); } catch { /* gone */ } }
            clients.clear();
            wss.close();
            finish();
          };
          const flushed = () => { if (--pending <= 0) cutSockets(); };
          if (pending === 0) {
            cutSockets();
          } else {
            const data = JSON.stringify({ type: 'server-closing' });
            for (const ws of clients) {
              try { ws.send(data, flushed); } catch { flushed(); }
            }
            // 3. A bound on the goodbye, so one backpressured socket cannot hold
            //    the process past the client's SIGKILL.
            setTimeout(cutSockets, GOODBYE_FLUSH_MS).unref();
          }

          // Whatever else happens, this resolves. A shutdown step that can hang
          // is worse than one that gives up: the caller is on a 4-second fuse.
          setTimeout(finish, CLOSE_DEADLINE_MS).unref();
        }),
      });
    });
  });
}
