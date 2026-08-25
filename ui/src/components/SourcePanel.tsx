// Left-panel Source tab: file list + CodeMirror LaTeX editor.
// "Live" mode (default ON) auto-saves ~1s after you stop typing — the server-
// side watcher then recompiles and the WS reload refreshes the PDF, giving the
// Overleaf/Typst type→render loop. Ctrl+S still saves immediately.
// When a reload event arrives and the editor has no unsaved changes, the open
// file is re-fetched so changes from an external editor don't get clobbered by a
// later save from a stale buffer.
// PDF clicks normally arrive with a genuine SyncTeX file+line. Visible prose
// refines macro-expanded blocks and remains the fallback for the WASM backend.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { EditorSelection, Prec } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import { latex } from 'codemirror-lang-latex';
import { findSourceLine, phrase, stripLatex } from '../sync';
import { FileTree } from './FileTree';
import { LivePreview, type LiveSourceEdit } from './LivePreview';
import { AssetPreview, type AssetSelection } from './AssetPreview';
import { ConflictError, loadFile, saveFile, type Status } from '../api';

const LIVE_DEBOUNCE_MS = 1200; // Live mode: recompile this long after you stop typing
const AUTOSAVE_MS = 30000;      // safety net: persist edits (no recompile) every 30s
const CONFLICT_MESSAGE =
  'This file changed on disk (an agent or another editor saved it) while you had unsaved edits. '
  + 'Copy your changes, then Reload to see the new version.';

/** The line ending a file arrived with. Decided when the file is READ, never
 * derived from the buffer afterwards, so typing can never flip it.
 *
 * Everything above the disk works in \n — CodeMirror's document, the Live
 * preview's offsets, every splice. CodeMirror cannot be talked out of this:
 * `Text.toString()` joins with \n whatever `lineSeparator` says, and feeding
 * the wrapper a \r\n `value` makes it replace the whole document on every
 * render. So the separator is restored at the one place it matters, the write.
 * Without that, one keystroke in a CRLF file rewrote every line ending in it
 * and the whole file landed in the next git diff. */
function lineSeparatorOf(text: string): string {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

// `\r?` too: a lone CR from a classic-Mac file would otherwise reach CodeMirror,
// which splits on it anyway, and every comparison against the buffer after that
// is against a string the editor no longer holds.
const toEditorText = (text: string): string => text.replace(/\r\n?/g, '\n');
const toDiskText = (text: string, separator: string): string => (
  separator === '\n' ? text : text.replace(/\n/g, separator)
);

interface SyncTarget { text: string; nonce: number; file?: string; line?: number; column?: number }
export type SourceMode = 'code' | 'visual';

function sourceOffsetAt(text: string, position: { line: number; column: number }): number | null {
  if (position.line < 1 || position.column < 0) return null;
  let line = 1;
  let start = 0;
  while (line < position.line) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) return null;
    start = newline + 1;
    line++;
  }
  const newline = text.indexOf('\n', start);
  let end = newline < 0 ? text.length : newline;
  if (end > start && text[end - 1] === '\r') end--;
  return position.column <= end - start ? start + position.column : null;
}

export function SourcePanel({
  reloadTick, syncTarget, onSyncToPdf, dead = false, liveStatus, compileSeq = 0,
  mode, wide = false, showModeToggle = true, onModeChange, preferredFile,
}: {
  reloadTick: number;
  syncTarget?: SyncTarget | null;
  onSyncToPdf?: (text: string) => void;
  /** Controlled presentation used by the global Code / Live views. */
  mode?: SourceMode;
  /** In a focused source workspace the file tree becomes a left sidebar. */
  wide?: boolean;
  /** Split view keeps the compact local Code / Live switch. */
  showModeToggle?: boolean;
  onModeChange?: (mode: SourceMode) => void;
  /** Main document name reported by the compiler; preferred over alphabetic file 1. */
  preferredFile?: string;
  /** The server this window came from has stopped; writes cannot land. */
  dead?: boolean;
  /** The live compile status. The save chip follows this rather than a timer —
   *  it is the only thing that knows when a compile is actually over. */
  liveStatus?: Status;
  /** Bumped whenever a compile ends. See the chip effect. */
  compileSeq?: number;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [activeAsset, setActiveAsset] = useState<AssetSelection | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [live, setLive] = useState(() => localStorage.getItem('ws-live') === '1'); // recompile-as-you-type, default off
  const [localVisual, setLocalVisual] = useState(() => localStorage.getItem('ws-visual') === '1');
  const visual = mode ? mode === 'visual' : localVisual;
  const chooseVisual = useCallback((next: boolean) => {
    setLocalVisual(next);
    onModeChange?.(next ? 'visual' : 'code');
  }, [onModeChange]);
  const [wrap, setWrap] = useState(() => localStorage.getItem('ws-wrap') === '1');
  const [treeHeight, setTreeHeight] = useState(() => {
    const v = Number(localStorage.getItem('ws-tree-h'));
    return Number.isFinite(v) && v >= 80 ? v : 150;
  });
  const [treeWidth, setTreeWidth] = useState(() => {
    const v = Number(localStorage.getItem('ws-tree-w'));
    return Number.isFinite(v) && v >= 190 ? v : 280;
  });
  const treeDrag = useRef<{ start: number; size: number } | null>(null);
  useEffect(() => { localStorage.setItem('ws-tree-h', String(treeHeight)); }, [treeHeight]);
  useEffect(() => { localStorage.setItem('ws-tree-w', String(treeWidth)); }, [treeWidth]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'compiling' | 'compile-failed' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  // Why the save failed, not just that it did. 'save failed' next to a
  // working-looking editor told the user nothing about their unsaved text.
  const [saveError, setSaveError] = useState<string | null>(null);
  const seqRef = useRef(compileSeq);
  seqRef.current = compileSeq;
  const contentRef = useRef(content);
  contentRef.current = content;
  const activeRef = useRef(active);
  activeRef.current = active;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const liveRef = useRef(live);
  liveRef.current = live;
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const cache = useRef<Map<string, string>>(new Map());
  // Unsaved text for files that are not currently open. The three data-loss bugs
  // in this file all came from the same gap: nothing tracked which text belonged
  // to which file, so a buffer could be discarded on a switch, or applied to the
  // wrong file, or declared saved when it was not.
  const parked = useRef<Map<string, string>>(new Map());
  // The version of each file this tab last saw on disk, and the line ending it
  // came with. Both belong to the READ, not to the buffer.
  const etags = useRef<Map<string, string>>(new Map());
  const separators = useRef<Map<string, string>>(new Map());
  // The path whose last save was refused because disk had moved on. While this
  // stands, nothing writes to that file on a timer — an autosave every 30s
  // against a 409 is a retry loop that can only ever fail.
  const [conflict, setConflict] = useState<string | null>(null);
  const conflictRef = useRef<string | null>(null);
  conflictRef.current = conflict;
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const pendingJump = useRef<{ path: string; line: number } | null>(null);
  // File reads can finish out of order (especially when a PDF click changes the
  // target twice quickly). Only the newest navigation is allowed to replace the
  // editor buffer.
  const openRequest = useRef(0);
  const initialChoice = useRef<string | null>(null);
  // Parked files plus the one on screen, so the marker is right for the file the
  // user is actually looking at as well as the ones they left.
  const allDirty = useMemo(() => {
    const s = new Set(dirtyPaths);
    if (dirty && active) s.add(active);
    else if (active) s.delete(active);
    return s;
  }, [dirtyPaths, dirty, active]);

  // Everything a read tells us about the file itself. A server too old to send
  // an ETag leaves nothing stored, and every later save on that path stays
  // unconditional — exactly today's behaviour, rather than a permanent 409.
  const rememberRead = useCallback((path: string, loaded: { content: string; etag: string | null }) => {
    if (loaded.etag) etags.current.set(path, loaded.etag);
    else etags.current.delete(path);
    separators.current.set(path, lineSeparatorOf(loaded.content));
  }, []);

  const openFile = useCallback(async (path: string) => {
    const request = ++openRequest.current;
    setActiveAsset(null);
    // Park the outgoing file's unsaved text before anything overwrites the
    // buffer. Without this, switching files silently threw the edits away: the
    // cache only ever held the last text FETCHED or SAVED, never the dirty
    // buffer, so three paragraphs typed into main.tex and then a click on
    // intro.tex left those paragraphs existing nowhere. No prompt, no warning,
    // and Live mode is off by default so autosave might be 30s away.
    const leaving = activeRef.current;
    if (leaving && leaving !== path && dirtyRef.current) {
      parked.current.set(leaving, contentRef.current);
      setDirtyPaths((s) => new Set(s).add(leaving));
    }

    // Coming back to a file we are holding unsaved text for: that text wins over
    // what is on disk, or reopening the tab would be the same silent discard.
    const held = parked.current.get(path);
    if (held !== undefined) {
      setActive(path);
      setContent(held);
      setDirty(true);
      setSaveState('idle');
      setLoadError(null);
      return;
    }

    try {
      const loaded = await loadFile(path);
      if (request !== openRequest.current) return;
      const text = toEditorText(loaded.content);
      cache.current.set(path, text);
      rememberRead(path, loaded);
      setActive(path);
      setContent(text);
      setDirty(false);
      setSaveState('idle');
      setLoadError(null);
      setConflict((c) => (c === path ? null : c));
    } catch (e) {
      if (request === openRequest.current) setLoadError(`Couldn't load ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [rememberRead]);

  const openAsset = useCallback((selection: AssetSelection) => {
    // An asset replaces only the visible editor surface. Keep the source buffer
    // parked exactly as a source-to-source switch does, so checking a figure can
    // never discard the paragraph that was being edited.
    ++openRequest.current; // invalidate an older source fetch still in flight
    initialChoice.current = null; // this is a user choice; don't auto-jump later
    const leaving = activeRef.current;
    if (leaving && dirtyRef.current) {
      parked.current.set(leaving, contentRef.current);
      setDirtyPaths((paths) => new Set(paths).add(leaving));
    }
    setActiveAsset(selection);
    setLoadError(null);
  }, []);

  useEffect(() => {
    fetch('/api/files').then((r) => r.json()).then((list: string[]) => {
      setFiles(list);
      if (list.length) {
        const wanted = preferredFile
          ? list.find((f) => f.replace(/\.tex$/i, '').split('/').pop() === preferredFile.replace(/\.tex$/i, '').split('/').pop())
          : undefined;
        const choice = wanted ?? list[0];
        initialChoice.current = choice;
        openFile(choice);
      }
    }).catch(() => {});
  }, [openFile]);

  // The WebSocket may report the main document after the file list returned.
  // Upgrade only the untouched automatic first choice; never steal the editor
  // after the user selected or edited another file.
  useEffect(() => {
    if (!preferredFile || !files.length || dirtyRef.current) return;
    const wantedStem = preferredFile.replace(/\.tex$/i, '').split('/').pop();
    const wanted = files.find((f) => f.replace(/\.tex$/i, '').split('/').pop() === wantedStem);
    if (!wanted || wanted === activeRef.current) return;
    if (initialChoice.current && activeRef.current === initialChoice.current) {
      initialChoice.current = wanted;
      void openFile(wanted);
    }
  }, [preferredFile, files, active, openFile]);

  // External edits (an AI agent or another editor) recompile → reload event. Drop the
  // cache so cross-file search re-reads, and refresh the open buffer when clean.
  useEffect(() => {
    cache.current.clear();
    const path = activeRef.current;
    if (!path || dirtyRef.current) return;
    loadFile(path)
      .then((loaded) => {
        const text = toEditorText(loaded.content);
        cache.current.set(path, text);
        // Only into the file it was fetched FOR. This request outlives a click:
        // it started for main.tex, the user opened intro.tex before it resolved,
        // and without this check main.tex's body was written into intro.tex's
        // editor — where the next Ctrl+S, or the Live debounce, or the 30s
        // autosave after one keystroke, saved it over intro.tex and then
        // compiled and checkpointed the wreckage.
        if (activeRef.current !== path) return;
        // The buffer is clean, so this read is now the version this tab holds:
        // adopt its ETag, or the next save would be conditional on a version
        // that is two edits old and 409 against text nobody disagrees with.
        rememberRead(path, loaded);
        if (text !== contentRef.current && !dirtyRef.current) setContent(text);
      })
      .catch(() => {});
  }, [reloadTick, rememberRead]);

  // Unsaved text lives only in this tab. The browser's own prompt is the last
  // thing standing between a stray Cmd-W and someone's afternoon.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current && parked.current.size === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Save the open file. `compile` true → also recompile (Ctrl+S / Save / Live);
  // false → a bare safety save that leaves the PDF untouched.
  const save = useCallback(async (compile: boolean, automatic = false) => {
    const path = activeRef.current;
    if (!path) return;
    // A conflict stands until a person resolves it. Timers must not push at it:
    // the Live debounce would re-PUT 1.2s later and the autosave every 30s
    // after that, each one refused, none of them telling anyone anything new.
    if (automatic && conflictRef.current === path) return;
    // An explicit Save after the banner has been read is a deliberate choice to
    // let this buffer win, so it goes out unconditionally.
    const overwrite = conflictRef.current === path;
    if (overwrite) etags.current.delete(path);
    setSaveState('saving');
    if (compile) seqAtSave.current = seqRef.current;
    try {
      // Through the api helper, which refuses when the server has said goodbye.
      // This was the one write that used `fetch` directly, so it was the one with
      // no guard — and the one where failing quietly costs the user their text
      // rather than a click. The old bare `catch` turned that into a small
      // "save failed" chip beside an editor that still looked like it worked.
      // Snapshot what is actually being written. Reading contentRef again after
      // the await describes a buffer that may have moved on.
      const written = contentRef.current;
      const nextEtag = await saveFile(
        path,
        toDiskText(written, separators.current.get(path) ?? '\n'),
        compile,
        etags.current.get(path) ?? null,
      );
      // Adopt the version the write produced. A server that answers without the
      // header gets no If-Match from us next time either — falling back to
      // today's unconditional write rather than 409ing against nothing.
      if (nextEtag) etags.current.set(path, nextEtag);
      else etags.current.delete(path);
      if (overwrite) setConflict((c) => (c === path ? null : c));
      cache.current.set(path, written);

      // Only clear the flag if nothing was typed while the request was in
      // flight. It used to clear unconditionally, so keystrokes during the PUT
      // were marked saved while disk still held the older text — and since
      // dirtyRef was then false forever, the interval skipped the file, the
      // Save button went disabled, and the next reload refetched and replaced
      // the editor with the older version. The user watched their text revert
      // with no error anywhere.
      if (contentRef.current === written) {
        setDirty(false);
        parked.current.delete(path);
        setDirtyPaths((s) => { const n = new Set(s); n.delete(path); return n; });
        setSaveState(compile ? 'compiling' : 'saved');
        // Only the bare save is over when the request is. A compiling chip is
        // cleared by the compile finishing — see the effect below. Clearing it
        // on a timer is what made Ctrl+S report a success that had not happened.
        if (!compile) setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } else {
        // Still dirty, deliberately: what is on disk is not what is on screen.
        setSaveState('idle');
      }
    } catch (e) {
      if (e instanceof ConflictError) {
        // Nothing was written, and nothing here rewrites the buffer: the user's
        // text is still the only copy of their edit and stays on screen.
        setConflict(path);
        setDirty(true);
        setSaveState('error');
        setSaveError(CONFLICT_MESSAGE);
        return;
      }
      setSaveState('error');
      setSaveError(e instanceof Error ? e.message : 'save failed');
    }
  }, []);

  /** Throw the buffer away for what is on disk now. The only exit from a
   * conflict that does not overwrite somebody. */
  const reloadFromDisk = useCallback(async (path: string) => {
    try {
      const loaded = await loadFile(path);
      rememberRead(path, loaded);
      parked.current.delete(path);
      setDirtyPaths((s) => { const n = new Set(s); n.delete(path); return n; });
      if (activeRef.current !== path) return;
      const text = toEditorText(loaded.content);
      cache.current.set(path, text);
      contentRef.current = text;
      setContent(text);
      setDirty(false);
      setConflict(null);
      setSaveState('idle');
      setSaveError(null);
    } catch (e) {
      setLoadError(`Couldn't reload ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [rememberRead]);

  // A compiling chip is cleared by the compile finishing — never by a clock.
  //
  // It used to clear on a two-second timer that had nothing to do with the
  // compile. On a real paper an edit takes ~12.5s, so the chip went quiet with
  // ten seconds still to run, and did exactly the same when the compile FAILED:
  // a save that broke the document looked like one that worked. The socket
  // already carries compiling/reload/compile-error; this follows that.
  //
  // What this does not do is tie the chip to *its own* compile — there is no id
  // to match on, and compiles are serialised, so a save made while another one
  // is in flight can be resolved by that one. That is a smaller lie than a
  // timer's (a compile really did just finish) and it needs a compile id on the
  // wire to fix properly.
  // Which compile generation this save is waiting on. Without it the effect
  // below fired while liveStatus still held the PREVIOUS compile's 'ok' and
  // declared success immediately — a race the browser smoke caught after the
  // first version of this fix looked right in the source.
  const seqAtSave = useRef(0);

  useEffect(() => {
    if (saveState !== 'compiling') return;
    if (compileSeq <= seqAtSave.current) return; // our compile has not ended yet
    if (liveStatus === 'ok') {
      setSaveState('saved');
      const t = setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
      return () => clearTimeout(t);
    }
    if (liveStatus === 'error') {
      // NOT 'error': that chip reads "⚠ NOT saved", and the file was saved —
      // it is the compile that failed. Reusing it would have replaced one false
      // statement with another.
      setSaveState('compile-failed');
      setSaveError('Your text was saved. The compile failed — see the error panel.');
    }
  }, [liveStatus, saveState, compileSeq]);

  const onChange = useCallback((v: string) => {
    // Keep the imperative ref current inside the same input event. Visual text
    // leaves can commit again before React paints the previous source update.
    contentRef.current = v;
    setContent(v);
    setDirty(true);
    // Live mode recompiles a short while after you stop typing (Typst-style).
    if (liveRef.current) {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      autoTimer.current = setTimeout(() => { void save(true, true); }, LIVE_DEBOUNCE_MS);
    }
  }, [save]);

  const applyLiveTextEdit = useCallback((edit: LiveSourceEdit): boolean => {
    const path = activeRef.current;
    if (!path) return false;
    if (edit.file !== path) {
      // Included files are editable too, but first bind the hidden CodeMirror
      // buffer to that file so undo, dirty tracking, and autosave keep one clear
      // owner. The Live view remains open after navigation.
      void openFile(edit.file);
      setLoadError(`Opened ${edit.file}. Click the text again to edit it safely.`);
      return false;
    }

    const current = contentRef.current;
    const from = sourceOffsetAt(current, edit.from);
    const to = sourceOffsetAt(current, edit.to);
    if (from === null || to === null || to < from) return false;
    const existing = current.slice(from, to);
    if (existing.replace(/\r\n/g, '\n') !== edit.expected.replace(/\r\n/g, '\n')) return false;

    setLoadError(null);
    onChange(current.slice(0, from) + edit.insert + current.slice(to));
    return true;
  }, [onChange, openFile]);

  // Safety-net auto-save every 30s when not in Live mode: persist edits to disk
  // WITHOUT recompiling, so you don't lose work but the PDF only rebuilds on demand.
  // Not while the window is dead: the write cannot land, and retrying it every
  // 30s only produces a stream of failures behind an editor that looks fine.
  useEffect(() => {
    if (dead) return;
    const iv = setInterval(() => { if (dirtyRef.current && !liveRef.current) void save(false, true); }, AUTOSAVE_MS);
    return () => clearInterval(iv);
  }, [save, dead]);

  useEffect(() => () => { if (autoTimer.current) clearTimeout(autoTimer.current); }, []);
  useEffect(() => { localStorage.setItem('ws-live', live ? '1' : '0'); }, [live]);

  // Scroll+select a 0-based line in the open editor.
  const jumpToLine = useCallback((line0: number) => {
    const view = cmRef.current?.view;
    if (!view) return;
    const line = view.state.doc.line(Math.min(line0 + 1, view.state.doc.lines));
    view.dispatch({
      selection: EditorSelection.range(line.from, line.to),
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  }, []);

  // After openFile swaps content in, run any pending jump for that file.
  useEffect(() => {
    const pending = pendingJump.current;
    if (!pending || active !== pending.path) return;
    pendingJump.current = null;
    requestAnimationFrame(() => {
      if (activeRef.current === pending.path) jumpToLine(pending.line);
    });
  }, [active, content, jumpToLine]);

  // PDF → source: prefer the genuine SyncTeX file+line. Visible prose refines
  // nearby macro-expanded material (all of \maketitle may map to one invocation)
  // and is still the full fallback for the bundled WASM engine.
  useEffect(() => {
    if (!syncTarget) return;
    let cancelled = false;
    // Cancel any older file navigation even when this target is already open
    // and therefore will not call openFile itself.
    openRequest.current++;
    pendingJump.current = null;
    void (async () => {
      const load = async (f: string): Promise<string | null> => {
        const held = parked.current.get(f);
        if (held !== undefined) return held;
        if (f === activeRef.current) return contentRef.current;
        if (!cache.current.has(f)) {
          try {
            const r = await fetch(`/api/file?path=${encodeURIComponent(f)}`);
            if (r.ok) cache.current.set(f, await r.text());
          } catch { /* ignore */ }
        }
        return cache.current.get(f) ?? null;
      };
      const jump = (f: string, line0: number) => {
        if (cancelled) return;
        if (f === activeRef.current) jumpToLine(line0);
        else { pendingJump.current = { path: f, line: line0 }; void openFile(f); }
      };

      if (syncTarget.file && syncTarget.line && syncTarget.line > 0) {
        const source = await load(syncTarget.file);
        if (cancelled) return;
        const refined = source && syncTarget.text
          ? findSourceLine(source, syncTarget.text, syncTarget.line)
          : null;
        jump(syncTarget.file, refined ?? syncTarget.line - 1);
        return;
      }

      if (!phrase(syncTarget.text, 3)) return;
      for (const f of files) {
        const source = await load(f);
        if (cancelled) return;
        if (source === null) continue;
        const line = findSourceLine(source, syncTarget.text);
        if (line !== null) { jump(f, line); return; }
      }
    })();
    return () => { cancelled = true; };
  }, [syncTarget, files, openFile, jumpToLine]);

  // ── Formatting toolbar: wrap the selection (or insert a snippet) ────────
  const wrapSelection = useCallback((before: string, after: string, placeholder = '') => {
    const view = cmRef.current?.view;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const sel = view.state.sliceDoc(from, to) || placeholder;
    const insert = before + sel + after;
    const caret = from + before.length + sel.length; // after the wrapped text
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: caret } });
    view.focus();
  }, []);

  const insertAtLineStart = useCallback((text: string) => {
    const view = cmRef.current?.view;
    if (!view) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    view.dispatch({ changes: { from: line.from, insert: text }, selection: { anchor: line.from + text.length } });
    view.focus();
  }, []);

  // source → PDF: on a click in the editor, send the current line's prose out.
  const emitSyncFromCursor = useCallback(() => {
    const view = cmRef.current?.view;
    if (!view || !onSyncToPdf) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const prose = phrase(stripLatex(line.text), 8);
    if (prose.split(' ').filter(Boolean).length >= 2) onSyncToPdf(line.text);
  }, [onSyncToPdf]);

  useEffect(() => { localStorage.setItem('ws-visual', visual ? '1' : '0'); }, [visual]);

  const extensions = useMemo(
    () => [
      latex(),
      Prec.high(keymap.of([{ key: 'Mod-s', run: () => { void save(true); return true; } }])),
      ...(wrap ? [EditorView.lineWrapping] : []),
    ],
    [save, wrap],
  );
  useEffect(() => { localStorage.setItem('ws-wrap', wrap ? '1' : '0'); }, [wrap]);

  const saveStateText = saveState === 'saving' ? 'saving…'
    : saveState === 'compiling' ? '✓ saved — recompiling'
      : saveState === 'saved' ? '✓ saved'
        : saveState === 'compile-failed' ? '✓ saved — ⚠ compile failed'
          : saveState === 'error' ? '⚠ NOT saved' : '';

  const editFromPreview = useCallback((line?: number, file?: string) => {
    chooseVisual(false);
    if (line === undefined) return;
    if (file && file !== activeRef.current) {
      pendingJump.current = { path: file, line: Math.max(0, line - 1) };
      void openFile(file);
      return;
    }
    // Keep CodeMirror mounted behind the preview, so its undo history and the
    // exact unsaved buffer survive. Reveal it, then focus the requested line.
    requestAnimationFrame(() => jumpToLine(Math.max(0, line - 1)));
  }, [chooseVisual, jumpToLine, openFile]);

  return (
    <div className={`source ${wide ? 'source-wide' : ''}`}>
      <div className="source-tree-pane" style={wide ? { width: treeWidth } : undefined}>
        <FileTree
          active={activeAsset?.path ?? active}
          onOpen={openFile}
          onOpenAsset={(path) => openAsset({ path })}
          refreshKey={reloadTick}
          height={wide ? undefined : treeHeight}
          dirtyPaths={allDirty}
        />
      </div>
      <div
        className="vsplitter"
        title={`Drag to resize the file tree ${wide ? 'width' : 'height'}`}
        onPointerDown={(e) => {
          treeDrag.current = { start: wide ? e.clientX : e.clientY, size: wide ? treeWidth : treeHeight };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          document.body.classList.add(wide ? 'resizing-tree-wide' : 'resizing-v');
        }}
        onPointerMove={(e) => {
          if (!treeDrag.current) return;
          const point = wide ? e.clientX : e.clientY;
          const next = treeDrag.current.size + point - treeDrag.current.start;
          if (wide) {
            const panelWidth = (e.currentTarget.parentElement as HTMLElement | null)?.clientWidth ?? window.innerWidth;
            setTreeWidth(Math.min(Math.max(next, 190), Math.max(240, panelWidth * 0.45)));
          } else {
            setTreeHeight(Math.min(Math.max(next, 80), window.innerHeight - 220));
          }
        }}
        onPointerUp={(e) => {
          treeDrag.current = null;
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
          document.body.classList.remove('resizing-v', 'resizing-tree-wide');
        }}
      />
      <div className="source-editor-pane">
        {loadError && <div className="panel-hint load-error">{loadError}</div>}
        {/* Nothing was written when this appears, and nothing here rewrites the
            buffer. The user's unsaved text stays on screen while they decide. */}
        {conflict && conflict === active && (
          <div className="panel-hint load-error save-conflict" role="alert">
            <span>{CONFLICT_MESSAGE}</span>
            <button onClick={() => void reloadFromDisk(conflict)} title="Discard this buffer and load what is on disk now">Reload</button>
            <button onClick={() => setConflict(null)} title="Hide this message and keep your unsaved text">Dismiss</button>
          </div>
        )}
        {activeAsset ? (
          <AssetPreview
            selection={activeAsset}
            refreshKey={reloadTick}
            onClose={() => setActiveAsset(null)}
          />
        ) : active ? (
          <>
            {visual && (
              <div className="live-source-pane">
                <div className="editor-bar live-editor-bar">
                  <span className="editor-file">{active}{dirty ? ' • unsaved' : ''}</span>
                  <span className="spacer" />
                  <span className={`save-state save-${saveState}`} title={saveError ?? undefined}>{saveStateText}</span>
                  <span className="live-edit-hint">Click prose to edit</span>
                  <button onClick={() => editFromPreview()} title="Edit exact LaTeX commands and protected constructs">Edit Code</button>
                  <button
                    onClick={() => void save(true)}
                    disabled={!dirty && saveState !== 'error'}
                    title={conflict === active
                      ? 'This file changed on disk. Saving now overwrites that newer version with your text.'
                      : 'Save source and compile the exact PDF'}
                  >Save &amp; compile</button>
                </div>
                <LivePreview
                  source={content}
                  file={active}
                  refreshKey={reloadTick}
                  onEdit={editFromPreview}
                  onTextEdit={applyLiveTextEdit}
                  onOpenAsset={openAsset}
                />
              </div>
            )}
            <div className={`source-code-pane ${visual ? 'view-hidden' : ''}`}>
              <div className="editor-bar">
                <span className="editor-file">{active}{dirty ? ' •' : ''}</span>
                {showModeToggle && (
                  <span className="seg" title="Code edits exact LaTeX; Live edits rendered prose while preserving protected commands">
                    <button className={visual ? '' : 'on'} onClick={() => chooseVisual(false)}>Code</button>
                    <button className={visual ? 'on' : ''} onClick={() => chooseVisual(true)}>Live</button>
                  </span>
                )}
                <span className="spacer" />
                {/* "save failed" beside a working-looking editor understated it: the
                    text is not on disk. The reason goes in the tooltip, since when
                    the server has stopped the reason is the only actionable part. */}
                <span className={`save-state save-${saveState}`} title={saveError ?? undefined}>{saveStateText}</span>
                <button
                  className={wrap ? 'on' : ''}
                  onClick={() => setWrap((v) => !v)}
                  title="Wrap long lines (for LaTeX written without line breaks)"
                >
                  ⏎ Wrap
                </button>
                <button
                  className={live ? 'on' : ''}
                  onClick={() => setLive((v) => !v)}
                  title="Auto PDF: recompile ~1s after you stop typing. Off: edits auto-save every 30s without recompiling — press Ctrl+S or Recompile to rebuild the PDF."
                >
                  ⚡ Auto PDF
                </button>
                <button
                  onClick={() => void save(true)}
                  disabled={!dirty && saveState !== 'error'}
                  title={conflict === active
                    ? 'This file changed on disk. Saving now overwrites that newer version with your text.'
                    : 'Save and recompile (Ctrl+S)'}
                >Save</button>
              </div>
              <div className="format-bar">
                <button title="Undo (Ctrl+Z)" onClick={() => { const v = cmRef.current?.view; if (v) { undo(v); v.focus(); } }}>↶</button>
                <button title="Redo (Ctrl+Y)" onClick={() => { const v = cmRef.current?.view; if (v) { redo(v); v.focus(); } }}>↷</button>
                <span className="fb-sep" />
                <button title="Bold" onClick={() => wrapSelection('\\textbf{', '}', 'bold')}><b>B</b></button>
                <button title="Italic" onClick={() => wrapSelection('\\emph{', '}', 'italic')}><i>I</i></button>
                <span className="fb-sep" />
                <button title="Section" onClick={() => insertAtLineStart('\\section{}')}>H1</button>
                <button title="Subsection" onClick={() => insertAtLineStart('\\subsection{}')}>H2</button>
                <span className="fb-sep" />
                <button title="Bullet list" onClick={() => wrapSelection('\\begin{itemize}\n  \\item ', '\n\\end{itemize}', '')}>•</button>
                <button title="Numbered list" onClick={() => wrapSelection('\\begin{enumerate}\n  \\item ', '\n\\end{enumerate}', '')}>1.</button>
                <span className="fb-sep" />
                <button title="Inline math" onClick={() => wrapSelection('$', '$', 'x')}>√x</button>
                <button title="Display equation" onClick={() => wrapSelection('\\[\n  ', '\n\\]', '')}>∑</button>
                <button title="Citation" onClick={() => wrapSelection('\\cite{', '}', 'key')}>[ ]</button>
              </div>
              <div className="editor-scroll" onClick={emitSyncFromCursor}>
                <CodeMirror
                  ref={cmRef}
                  value={content}
                  theme="dark"
                  height="100%"
                  extensions={extensions}
                  onChange={onChange}
                  basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
                />
              </div>
            </div>
          </>
        ) : <div className="panel-hint">Select a source file to begin editing.</div>}
      </div>
    </div>
  );
}
