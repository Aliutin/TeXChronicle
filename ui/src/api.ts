// Same-origin API helpers + the WebSocket live channel. The UI is served by the
// preview server itself, so everything is relative — no config, no CORS.
import { useEffect, useRef, useState } from 'react';
import { extractDocumentTitle } from './sync';

export interface Checkpoint {
  sha: string;
  time: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  hasPdf: boolean;
}

export type SectionChange = 'created' | 'edited' | 'renamed' | 'moved' | 'reordered' | 'structure' | 'descendant';
export type MatchConfidence = 'exact' | 'high' | 'medium' | 'low';

export interface SectionVersion {
  versionId: string;
  sha: string;
  time: string;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  parentId?: string;
  changes: SectionChange[];
  confidence: MatchConfidence;
  matchScore: number;
  predecessorIds: string[];
  hasPdf: boolean;
}

export interface SectionHistoryItem {
  id: string;
  title: string;
  label?: string;
  command: string;
  level: number;
  appendix: boolean;
  path: string;
  parentId?: string;
  order: number;
  present: boolean;
  versions: SectionVersion[];
}

export interface SectionHistoryPayload {
  head: string;
  checkpointCount: number;
  sections: SectionHistoryItem[];
}

export interface SectionDiffResult {
  sectionId: string;
  sha: string;
  predecessorSha?: string;
  title: string;
  previousTitle?: string;
  scope: 'text' | 'subtree';
  diff: string;
}

export type WsMessage =
  | { type: 'reload'; name?: string; checkpoint?: string }
  | { type: 'compiling' }
  | { type: 'compile-error'; log: string }
  | { type: 'comments-changed' }
  // Sent once, as the server shuts down. Every start binds a fresh port, so this
  // tab will never reach that server again — and its contents are now history.
  | { type: 'server-closing' };

export interface CommentRect { x: number; y: number; w: number; h: number }
export type CommentStatus = 'suggested' | 'accepted' | 'resolved';
export type CommentRole = 'human' | 'reviewer' | 'defender' | 'author';
export interface Reply { by: CommentRole; text: string; at: string }
export interface RestoreReview {
  checkpoint: string;
  scope: 'project' | 'section' | 'file';
  label?: string;
  at: string;
}
export interface Comment {
  id: string;
  page: number;
  quote: string;
  rects: CommentRect[];
  text: string;
  status: CommentStatus;
  role?: CommentRole;
  replies?: Reply[];
  created: string;
  createdCheckpoint?: string;
  sourceFile?: string;
  sourceLine?: number;
  resolvedNote?: string;
  resolvedAt?: string;
  resolvedCheckpoint?: string;
  verifiedCheckpoint?: string;
  verifiedAt?: string;
  restoreReview?: RestoreReview;
}

/**
 * Whether the server this page was loaded from has stopped for good.
 *
 * It lives here, not in a component, because every panel already goes through
 * this module and none of them were told. The dead-window banner was threaded to
 * the toolbar alone, so the editor kept autosaving into a closed port, History
 * kept offering a destructive restore, and Comments kept accepting replies —
 * each failing into a bare `catch` or no catch at all. One guard at the choke
 * point covers all of them.
 */
let serverGone = false;

export class ServerGoneError extends Error {
  constructor() {
    super('The TeXChronicle server this window was connected to has stopped. Restart TeXChronicle from the terminal to open a new live window.');
    this.name = 'ServerGoneError';
  }
}

export function isServerGone(): boolean { return serverGone; }

/** Refuse a write that cannot land, with a message worth showing. */
function requireLive(): void {
  if (serverGone) throw new ServerGoneError();
}

export async function fetchComments(): Promise<Comment[]> {
  const r = await fetch('/api/comments');
  return r.ok ? r.json() : [];
}

export async function createComment(input: { page: number; quote: string; rects: CommentRect[]; text: string }): Promise<void> {
  requireLive();
  await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}

export async function patchComment(id: string, patch: { status?: CommentStatus; text?: string; restoreReview?: null }): Promise<void> {
  requireLive();
  const r = await fetch(`/api/comments?id=${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error((await r.text()) || 'comment update failed');
}

export async function removeComment(id: string): Promise<void> {
  requireLive();
  await fetch(`/api/comments?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function replyComment(id: string, text: string): Promise<void> {
  requireLive();
  await fetch(`/api/comments/reply?id=${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, by: 'human' }),
  });
}

// `disconnected` is a hiccup worth retrying through; `stopped` means the server
// this tab was talking to is gone for good. They looked the same until a real
// bug report was filed off a dead tab — the pane was showing that server's last
// error while a live instance compiled the same paper fine on another port.
export type Status = 'connecting' | 'connected' | 'compiling' | 'ok' | 'error' | 'disconnected' | 'stopped';

export async function fetchCheckpoints(): Promise<Checkpoint[]> {
  const r = await fetch('/git/checkpoints');
  return r.ok ? r.json() : [];
}

export async function fetchDiff(sha: string): Promise<string> {
  const r = await fetch(`/git/diff?sha=${encodeURIComponent(sha)}`);
  return r.ok ? r.text() : '';
}

export interface SyncTeXSourceLocation {
  file: string;
  line: number;
  column?: number;
}

/** Resolve a PDF point to project source. Null means no genuine map is
 * available (WASM/historical render) or SyncTeX found no nearby source node. */
export async function inverseSyncTeX(page: number, x: number, y: number): Promise<SyncTeXSourceLocation | null> {
  try {
    const query = new URLSearchParams({
      page: String(page), x: x.toFixed(3), y: y.toFixed(3),
    });
    const r = await fetch(`/api/synctex/inverse?${query}`);
    if (!r.ok) return null;
    const result = await r.json() as { available?: boolean } & Partial<SyncTeXSourceLocation>;
    return result.available && typeof result.file === 'string' && Number.isInteger(result.line)
      ? { file: result.file, line: result.line!, ...(result.column === undefined ? {} : { column: result.column }) }
      : null;
  } catch {
    return null;
  }
}

export async function fetchSectionHistory(): Promise<SectionHistoryPayload> {
  const r = await fetch('/git/sections');
  if (!r.ok) throw new Error((await r.text()) || 'section history failed');
  return r.json();
}

export async function fetchSectionDiff(section: string, sha: string, subtree: boolean): Promise<SectionDiffResult> {
  const query = new URLSearchParams({ section, sha, subtree: subtree ? '1' : '0' });
  const r = await fetch(`/git/section-diff?${query}`);
  if (!r.ok) throw new Error((await r.text()) || 'section diff failed');
  return r.json();
}

/** Restore one semantic section (including its subsections), reversibly. */
export async function restoreSection(section: string, sha: string): Promise<string | null> {
  if (serverGone) return new ServerGoneError().message;
  const query = new URLSearchParams({ section, sha });
  const r = await fetch(`/git/restore-section?${query}`, { method: 'POST' });
  return restoreResponse(r, 'section restore failed');
}

export function historicalPdfUrl(sha: string): string {
  return `/git/render?sha=${encodeURIComponent(sha)}`;
}

/** Restore the working tree to a checkpoint (revert). Returns an error string or null. */
export async function restoreCheckpoint(sha: string): Promise<string | null> {
  if (serverGone) return new ServerGoneError().message;
  const r = await fetch(`/git/restore?sha=${encodeURIComponent(sha)}`, { method: 'POST' });
  return restoreResponse(r, 'restore failed');
}

/** Restore a single file to a checkpoint version. Returns an error string or null. */
export async function restoreFile(sha: string, path: string): Promise<string | null> {
  if (serverGone) return new ServerGoneError().message;
  const r = await fetch(`/git/restore-file?sha=${encodeURIComponent(sha)}&path=${encodeURIComponent(path)}`, { method: 'POST' });
  return restoreResponse(r, 'restore failed');
}

async function restoreResponse(response: Response, fallback: string): Promise<string | null> {
  if (!response.ok) return (await response.text()) || fallback;
  const result = await response.json().catch(() => ({})) as { compiled?: boolean; warning?: string };
  if (result.warning) return `Restore succeeded. ${result.warning}`;
  if (result.compiled === false) {
    return 'Restore succeeded, but the restored source did not compile successfully. The previous PDF remains visible; open the compile log for details.';
  }
  return null;
}

/**
 * Where this project's history lives.
 *
 * Two ways to have none, and they need different answers: install git, or look
 * at a path. Reporting both as "no git found" sent people to install software
 * they already had, and left them nowhere to go once they had.
 *
 * The shell surfaces this outside the History tab, because a reader who never
 * opens that tab would otherwise never learn there is no record of what an
 * agent changed.
 */
export type HistoryMode = 'project' | 'shadow' | 'no-git' | 'unwritable';

export async function fetchGitStatus(): Promise<{ isRepo: boolean; mode: HistoryMode; detail?: string }> {
  try {
    const j = await (await fetch('/git/status')).json();
    return { isRepo: !!j.isRepo, mode: (j.mode as HistoryMode) ?? (j.isRepo ? 'project' : 'no-git'), detail: j.detail };
  } catch {
    return { isRepo: false, mode: 'no-git' };
  }
}

export async function fetchOverleafLink(): Promise<string | null> {
  try { return (await (await fetch('/overleaf/link')).json()).url ?? null; } catch { return null; }
}

export interface TreeNode { name: string; path: string; type: 'file' | 'dir'; editable?: boolean; children?: TreeNode[] }
export async function fetchTree(): Promise<TreeNode[]> {
  const r = await fetch('/api/tree');
  return r.ok ? r.json() : [];
}
/** Browser-safe URL for an image/PDF inside the selected project. `from` lets
 *  the server resolve paths used by an included .tex file without weakening the
 *  project-root boundary. */
export function projectAssetUrl(path: string, refreshKey = 0, from?: string): string {
  const query = new URLSearchParams({ path, v: String(refreshKey) });
  if (from) query.set('from', from);
  return `/api/asset?${query.toString()}`;
}
/** Upload a figure/asset to `path` (relative to the project root). */
export async function uploadFile(path: string, file: File): Promise<string | null> {
  if (serverGone) return new ServerGoneError().message;
  const r = await fetch(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: await file.arrayBuffer() });
  return r.ok ? null : (await r.text()) || 'upload failed';
}
/** File-system op: mkfile | mkdir | rename | delete. Returns an error string or null. */
export async function fsOp(op: string, path: string, to?: string): Promise<string | null> {
  if (serverGone) return new ServerGoneError().message;
  const r = await fetch('/api/fs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, path, to }),
  });
  return r.ok ? null : (await r.text()) || 'operation failed';
}

/**
 * Write a project file. `compile` is Ctrl+S / Save; a bare autosave passes false.
 *
 * The editor used to call `fetch` directly, so it was the one write with no
 * guard — and the one where failing silently costs the user their text rather
 * than a click.
 */
export async function saveFile(path: string, content: string, compile: boolean): Promise<void> {
  requireLive();
  const r = await fetch(`/api/file?path=${encodeURIComponent(path)}&compile=${compile ? 1 : 0}`, {
    method: 'PUT', body: content,
  });
  if (!r.ok) throw new Error((await r.text()) || 'save failed');
}

/** Trigger a compile now (the toolbar's manual "Recompile"). */
export async function recompile(): Promise<void> {
  requireLive();
  try { await fetch('/api/recompile', { method: 'POST' }); } catch { /* ignore */ }
}

/** The document's \title{…} (from the compiled main .tex) for the header. */
export async function fetchDocTitle(preferredMain?: string): Promise<string | null> {
  try {
    const files: string[] = await (await fetch('/api/files')).json();
    const wantedStem = preferredMain?.replace(/\.tex$/i, '').split(/[\\/]/).pop();
    const ordered = [...files].sort((a, b) => {
      const stem = (f: string) => f.replace(/\.tex$/i, '').split('/').pop();
      return Number(stem(b) === wantedStem) - Number(stem(a) === wantedStem);
    });
    for (const f of ordered) {
      if (!/\.tex$/i.test(f)) continue;
      const src = await (await fetch(`/api/file?path=${encodeURIComponent(f)}`)).text();
      if (!/\\documentclass/.test(src)) continue;
      const title = extractDocumentTitle(src);
      if (title) return title;
    }
  } catch { /* ignore */ }
  return null;
}

/** Live channel: connection state + a bump counter that increments on each reload. */
export function useLive(onMessage?: (m: WsMessage) => void) {
  const [status, setStatus] = useState<Status>('connecting');
  const [errorLog, setErrorLog] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  // Bumped by anything that ENDS a compile, success or failure. A caller that
  // records it before triggering one can then tell "my compile finished" from
  // "the status still says what the last compile left behind" — which a bare
  // `status === 'ok'` cannot, and which made the save chip declare success the
  // instant it was shown.
  const [compileSeq, setCompileSeq] = useState(0);
  const [pdfName, setPdfName] = useState('preview');
  const [pdfCheckpoint, setPdfCheckpoint] = useState<string | undefined>();
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;   // this component unmounted
    let farewell = false; // the server said goodbye — final, never retried
    let downSince = 0;    // wall clock, not an attempt count
    let retry: ReturnType<typeof setTimeout> | null = null;

    // Judged by elapsed time, not by number of attempts. Counting attempts
    // assumed each retry costs a second, which is false in two directions: a
    // slept laptop fires every overdue timer at once, so eleven failures could
    // land in a moment and declare a *live* server dead; and a hidden tab is
    // throttled to about one timer a minute, so ten attempts could span ten
    // minutes on a server that was already gone.
    const GIVE_UP_MS = 10_000;

    const connect = () => {
      ws = new WebSocket(`ws://${location.host}`);
      ws.onopen = () => {
        // Recovery. `stopped` used to latch with no way back, so one bad patch
        // of network left a working window permanently disabled until a manual
        // reload. A socket that opens is proof the server is there.
        downSince = 0;
        setStatus('connected');
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as WsMessage;
        if (msg.type === 'server-closing') {
          // An explicit goodbye: no point retrying, and no point pretending the
          // pane's contents still mean anything.
          farewell = true;
          serverGone = true;
          setStatus('stopped');
          return;
        }
        if (msg.type === 'reload') {
          if (msg.name) setPdfName(String(msg.name).split(/[\\/]/).pop()!.replace(/\.tex$/i, '') || 'preview');
          setPdfCheckpoint(msg.checkpoint);
          setErrorLog('');
          setStatus('ok');
          setReloadTick((t) => t + 1);
          setCompileSeq((n) => n + 1);
        } else if (msg.type === 'compiling') {
          setStatus('compiling');
        } else if (msg.type === 'compile-error') {
          setStatus('error');
          setErrorLog(msg.log || 'compile failed');
          setCompileSeq((n) => n + 1);
        }
        cbRef.current?.(msg);
      };
      ws.onclose = () => {
        if (closed || farewell) return;
        downSince ||= Date.now();
        // Down long enough to say so — but keep retrying underneath. Retrying
        // forever *silently* is what made a dead tab look busy rather than
        // finished; giving up entirely is what made a live one unusable after a
        // network blip. Say "stopped", keep knocking.
        setStatus(Date.now() - downSince >= GIVE_UP_MS ? 'stopped' : 'disconnected');
        retry = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      // The pending retry has to go too. Without this an unmount inside the
      // one-second window still fired connect(), opening a socket that nothing
      // owned or closed — leaked into the server's client set, where it then
      // held up the server's own shutdown.
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { status, errorLog, reloadTick, pdfName, pdfCheckpoint, compileSeq };
}
