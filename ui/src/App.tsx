// The workspace shell: toolbar on top; left tabbed panel (Source | History);
// PDF center with anchored comments; Comments workspace on the right. Both side
// panels resize with Overleaf-style drag splitters (widths persisted).
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchComments, fetchGitStatus, historicalPdfUrl, useLive, type Comment, type HistoryMode, type SyncTeXSourceLocation } from './api';
import { Toolbar } from './components/Toolbar';
import { PdfView } from './components/PdfView';
import { HistoryPanel } from './components/HistoryPanel';
import { SourcePanel } from './components/SourcePanel';
import { CommentsPanel } from './components/CommentsPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

type LeftTab = 'source' | 'history';

// Minimum widths are measured, not guessed. The left panel carries fixed-size
// control rows, and the widest rigid one is the format bar: 15 buttons that
// cannot shrink or collapse, needing 375px. Below that the rows wrap and the
// controls scroll out of sight. 400 leaves margin for the file tree's header
// and the editor bar. The right panel is prose that reflows, so it goes lower.
// Keep MIN_LEFT in sync with --min-left in styles.css.
const MIN_LEFT = 400;
const MIN_RIGHT = 260;
const maxPanel = (min: number) => Math.max(min, Math.floor(window.innerWidth * 0.6));

/** Panel width with drag-resize support, persisted to localStorage. */
function usePanelWidth(key: string, initial: number, min: number) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    // A width persisted by an older build can be narrower than today's minimum,
    // so clamp up rather than only rejecting non-numbers.
    if (!Number.isFinite(saved) || saved <= 0) return initial;
    return Math.min(Math.max(saved, min), maxPanel(min));
  });
  useEffect(() => { localStorage.setItem(key, String(width)); }, [key, width]);
  return [width, setWidth] as const;
}

/** Overleaf-style drag handle. `dir` is which side the panel sits on. */
function Splitter({ dir, width, setWidth, min }: { dir: 'left' | 'right'; width: number; setWidth: (w: number) => void; min: number }) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  return (
    <div
      className="splitter"
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX, startW: width };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = e.clientX - drag.current.startX;
        const next = dir === 'left' ? drag.current.startW + dx : drag.current.startW - dx;
        setWidth(Math.min(Math.max(next, min), maxPanel(min)));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        document.body.classList.remove('resizing');
      }}
      title="Drag to resize"
    />
  );
}

export default function App() {
  const [comments, setComments] = useState<Comment[]>([]);
  const [selectedComment, setSelectedComment] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>('history');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [pages, setPages] = useState(0);
  const [leftWidth, setLeftWidth] = usePanelWidth('ws-left-width', 420, MIN_LEFT);
  const [rightWidth, setRightWidth] = usePanelWidth('ws-right-width', 320, MIN_RIGHT);
  // Genuine SyncTeX location when available, visible-text fallback otherwise.
  // The nonce forces re-fire even when the same point is clicked twice.
  const [syncToSource, setSyncToSource] = useState<({ text: string; nonce: number } & Partial<SyncTeXSourceLocation>) | null>(null);
  // Read once at mount: whether git exists doesn't change under a running server.
  const [historyMode, setHistoryMode] = useState<HistoryMode | null>(null);
  const [historyDetail, setHistoryDetail] = useState<string | undefined>();
  // Anything that isn't 'project' or 'shadow' means nothing is being recorded.
  const noHistory = historyMode === 'no-git' || historyMode === 'unwritable';
  const [warnDismissed, setWarnDismissed] = useState(false);
  useEffect(() => { fetchGitStatus().then((s) => { setHistoryMode(s.mode); setHistoryDetail(s.detail); }); }, []);
  const [syncToPdf, setSyncToPdf] = useState<{ text: string; nonce: number } | null>(null);
  const [historicalPdf, setHistoricalPdf] = useState<{ sha: string; title: string } | null>(null);
  const onSyncToSource = useCallback((target: { text: string } & Partial<SyncTeXSourceLocation>) => {
    setLeftTab('source');
    setLeftOpen(true);
    setSyncToSource({ ...target, nonce: Date.now() });
  }, []);
  const onSyncToPdf = useCallback((text: string) => { setSyncToPdf({ text, nonce: Date.now() }); }, []);
  const onPreviewVersion = useCallback((sha: string, title: string) => {
    setHistoricalPdf({ sha, title });
    // PdfView retries the text jump after its historical pages finish rendering.
    setSyncToPdf({ text: title, nonce: Date.now() });
  }, []);

  const refreshComments = useCallback(() => { fetchComments().then(setComments).catch(() => {}); }, []);
  useEffect(() => { refreshComments(); }, [refreshComments]);

  const { status, errorLog, reloadTick, pdfName, compileSeq } = useLive((m) => {
    if (m.type === 'comments-changed') { refreshComments(); setRightOpen(true); }
  });

  const jumpToComment = useCallback((c: Comment) => {
    setSelectedComment(c.id);
    const hls = document.querySelectorAll(`.hl[data-id="${c.id}"]`);
    if (hls.length) {
      hls[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      for (const el of hls) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
    } else {
      // Resolved comments carry no highlight — locate the passage by text and flash it.
      setSyncToPdf({ text: c.quote, nonce: Date.now() });
    }
  }, []);

  const onSelectFromPdf = useCallback((id: string) => { setSelectedComment(id); setRightOpen(true); }, []);

  return (
    <div className="app">
      <Toolbar
        status={status} pages={pages} pdfName={pdfName} reloadTick={reloadTick}
        commentsOpen={rightOpen}
        openCount={comments.filter((c) => c.status !== 'resolved').length}
        onToggleComments={() => setRightOpen((o) => !o)}
      />
      {/* A window whose server has stopped keeps showing that server's last
          render — including its last error. Not dismissible and above everything
          else, because the failure mode is someone reading a stale error as a
          current one: that happened, and a real bug was reported off a dead tab
          while a live instance compiled the same paper fine on another port.
          Every start binds a fresh port, so this window cannot recover. */}
      {status === 'stopped' && (
        <div className="banner-dead" role="alert">
          <strong>This window is no longer live.</strong>{' '}
          The MagicTeX server it was connected to has stopped, so everything below is a
          snapshot from when it did — <em>including any error message</em>. Ask Claude to
          render a preview again; that opens a new window at a new address. This one can be
          closed.
        </div>
      )}
      {/* Losing the change record is not a footnote. Someone letting an agent
          edit their paper should learn that nothing is being recorded before
          they need to look something up, not when they open a tab they may
          never open. Dismissible, because after you've read it once it's noise. */}
      {noHistory && !warnDismissed && (
        <div className="banner-warn" role="status">
          <strong>Change history is off.</strong>{' '}
          {historyMode === 'no-git' ? (
            <>
              No <code>git</code> was found on your PATH, so edits aren't being recorded and you
              can't diff or roll back. Everything else works. Install from{' '}
              <a href="https://git-scm.com/" target="_blank" rel="noreferrer">git-scm.com</a> and
              restart — no account or remote is involved; the history stays on this machine.
            </>
          ) : (
            <>
              MagicTeX couldn't create its history store, so edits aren't being recorded.
              Everything else works, and <code>git</code> itself is fine — the problem is
              this path: <code>{historyDetail ?? 'unknown error'}</code>
            </>
          )}
          <button className="ghost" onClick={() => setWarnDismissed(true)} title="Dismiss">×</button>
        </div>
      )}
      <div className="layout">
        <div className={`left ${leftOpen ? '' : 'closed'}`} style={leftOpen ? { flexBasis: leftWidth } : undefined}>
          <div className="tabs">
            <button className={leftTab === 'source' ? 'on' : ''} onClick={() => setLeftTab('source')}>Source</button>
            <button className={leftTab === 'history' ? 'on' : ''} onClick={() => setLeftTab('history')}>
              History{noHistory && <span className="tab-warn" title="Nothing is being recorded — see the banner">!</span>}
            </button>
            <span className="spacer" />
            <button className="ghost" onClick={() => setLeftOpen(false)} title="Collapse">«</button>
          </div>
          {leftTab === 'history' && <ErrorBoundary name="History panel"><HistoryPanel reloadTick={reloadTick} onPreviewVersion={onPreviewVersion} /></ErrorBoundary>}
          {leftTab === 'source' && <ErrorBoundary name="Source editor"><SourcePanel reloadTick={reloadTick} syncTarget={syncToSource} onSyncToPdf={onSyncToPdf} dead={status === "stopped"} liveStatus={status} compileSeq={compileSeq} /></ErrorBoundary>}
        </div>
        {leftOpen && <Splitter dir="left" width={leftWidth} setWidth={setLeftWidth} min={MIN_LEFT} />}
        {!leftOpen && <button className="edge-open left-edge" onClick={() => setLeftOpen(true)} title="Open panel">»</button>}

        <div className="center">
          {errorLog && <pre className="compile-error">{errorLog}</pre>}
          <ErrorBoundary name="PDF view">
            <PdfView
              reloadTick={reloadTick}
              pdfUrl={historicalPdf ? historicalPdfUrl(historicalPdf.sha) : '/latest.pdf'}
              historicalLabel={historicalPdf?.title}
              onReturnLatest={historicalPdf ? () => setHistoricalPdf(null) : undefined}
              comments={historicalPdf ? [] : comments}
              onPages={setPages}
              onSelectComment={historicalPdf ? undefined : onSelectFromPdf}
              onSyncToSource={historicalPdf ? undefined : onSyncToSource}
              syncTarget={syncToPdf}
            />
          </ErrorBoundary>
        </div>

        {rightOpen && <Splitter dir="right" width={rightWidth} setWidth={setRightWidth} min={MIN_RIGHT} />}
        <div className={`right ${rightOpen ? '' : 'closed'}`} style={rightOpen ? { flexBasis: rightWidth } : undefined}>
          <div className="tabs">
            <strong className="tab-title">Comments</strong>
            <span className="spacer" />
            <button className="ghost" onClick={() => setRightOpen(false)} title="Collapse">»</button>
          </div>
          <ErrorBoundary name="Comments panel">
            <CommentsPanel comments={comments} selectedId={selectedComment} onJump={jumpToComment} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
