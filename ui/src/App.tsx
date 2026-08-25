// The workspace shell: toolbar on top; primary Code / Live / PDF / Split
// workspaces; History and Comments remain one click away. History uses its own
// version browser + large code-diff canvas, with the exact PDF available on demand.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchComments, fetchGitStatus, historicalPdfUrl, useLive, type Comment, type HistoryMode, type SyncTeXSourceLocation } from './api';
import { Toolbar } from './components/Toolbar';
import { PdfView } from './components/PdfView';
import { HistoryPanel, type HistoryDiffDetail, type HistorySelection } from './components/HistoryPanel';
import { DiffView } from './components/DiffView';
import { SourcePanel } from './components/SourcePanel';
import { CommentsPanel } from './components/CommentsPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

type LeftTab = 'source' | 'history';
type WorkspaceView = 'code' | 'visual' | 'pdf' | 'split' | 'history';
type EditorMode = 'code' | 'visual';
type HistoryPane = 'diff' | 'pdf';

const WORKSPACE_VIEWS: WorkspaceView[] = ['code', 'visual', 'pdf', 'split', 'history'];
const WORKSPACE_HELP: Record<WorkspaceView, string> = {
  code: 'Raw LaTeX editor',
  visual: 'Source-preserving visual editor',
  pdf: 'Compiled document',
  split: 'Source and PDF together',
  history: 'Version browser and precise code changes',
};

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
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(() => {
    const saved = localStorage.getItem('ws-workspace-view') as WorkspaceView | null;
    return saved && WORKSPACE_VIEWS.includes(saved) ? saved : 'pdf';
  });
  const [editorMode, setEditorMode] = useState<EditorMode>(() =>
    localStorage.getItem('ws-visual') === '1' ? 'visual' : 'code',
  );
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
  const [historySelection, setHistorySelection] = useState<HistorySelection | null>(null);
  const [historyDiffDetail, setHistoryDiffDetail] = useState<HistoryDiffDetail | null>(null);
  const [historyPane, setHistoryPane] = useState<HistoryPane>('diff');
  useEffect(() => { localStorage.setItem('ws-workspace-view', workspaceView); }, [workspaceView]);
  useEffect(() => {
    if (workspaceView === 'code' || workspaceView === 'visual') setLeftTab('source');
    else if (workspaceView === 'history') setLeftTab('history');
  }, [workspaceView]);

  const showWorkspace = useCallback((view: WorkspaceView) => {
    setWorkspaceView(view);
    if (view === 'code' || view === 'visual') {
      setEditorMode(view);
      setLeftTab('source');
      setLeftOpen(true);
    } else if (view === 'history') {
      setLeftTab('history');
      setLeftOpen(true);
      setHistoryPane('diff');
      setHistoricalPdf(null);
    }
  }, []);

  const onSyncToSource = useCallback((target: { text: string } & Partial<SyncTeXSourceLocation>) => {
    setLeftTab('source');
    setLeftOpen(true);
    // In a focused PDF/history view, the destination should become visible.
    // Split already has both sides, so preserve it there.
    setWorkspaceView((view) => view === 'split' ? view : 'code');
    setEditorMode('code');
    setSyncToSource({ ...target, nonce: Date.now() });
  }, []);
  const onSyncToPdf = useCallback((text: string) => { setSyncToPdf({ text, nonce: Date.now() }); }, []);
  const onPreviewVersion = useCallback((sha: string, title: string) => {
    setHistoricalPdf({ sha, title });
    // A history selection changes the PDF inside the current two-pane workspace.
    // It must not navigate to the focused PDF view and hide the timeline.
    setLeftTab('history');
    setLeftOpen(true);
    setHistoryPane('pdf');
    // PdfView retries the text jump after its historical pages finish rendering.
    setSyncToPdf({ text: title, nonce: Date.now() });
  }, []);
  const onHistorySelection = useCallback((selection: HistorySelection) => {
    setHistorySelection(selection);
    setHistoryPane('diff');
    setHistoricalPdf(null);
  }, []);
  const onHistoryDiff = useCallback((detail: HistoryDiffDetail) => {
    setHistoryDiffDetail(detail);
  }, []);
  const showSelectedHistoryPdf = useCallback(() => {
    if (!historySelection?.hasPdf) return;
    setHistoricalPdf({ sha: historySelection.sha, title: historySelection.title });
    setHistoryPane('pdf');
    setSyncToPdf({ text: historySelection.title, nonce: Date.now() });
  }, [historySelection]);

  const refreshComments = useCallback(() => { fetchComments().then(setComments).catch(() => {}); }, []);
  useEffect(() => { refreshComments(); }, [refreshComments]);

  const { status, errorLog, reloadTick, pdfName, pdfCheckpoint, compileSeq } = useLive((m) => {
    if (m.type === 'comments-changed') { refreshComments(); setRightOpen(true); }
  });

  const historyOrSplit = workspaceView === 'history' || workspaceView === 'split';

  const jumpToComment = useCallback((c: Comment) => {
    setSelectedComment(c.id);
    setWorkspaceView('pdf');
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
          The TeXChronicle server it was connected to has stopped, so everything below is a
          snapshot from when it did — <em>including any error message</em>. Restart
          TeXChronicle from the terminal; that opens a new live window at a new address.
          This one can be closed.
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
              TeXChronicle couldn't create its history store, so edits aren't being recorded.
              Everything else works, and <code>git</code> itself is fine — the problem is
              this path: <code>{historyDetail ?? 'unknown error'}</code>
            </>
          )}
          <button className="ghost" onClick={() => setWarnDismissed(true)} title="Dismiss">×</button>
        </div>
      )}
      <nav className="workspace-nav" aria-label="Workspace view">
        <span className="workspace-nav-label">View</span>
        {(['code', 'visual', 'pdf', 'split'] as WorkspaceView[]).map((view) => (
          <button
            key={view}
            className={workspaceView === view ? 'on' : ''}
            aria-pressed={workspaceView === view}
            onClick={() => showWorkspace(view)}
            title={WORKSPACE_HELP[view]}
          >
            {view === 'code' ? 'Code' : view === 'visual' ? 'Live' : view === 'pdf' ? 'PDF' : 'Split'}
          </button>
        ))}
        <span className="workspace-help">{WORKSPACE_HELP[workspaceView]}</span>
        <span className="spacer" />
        <button
          className={workspaceView === 'history' ? 'on' : ''}
          aria-pressed={workspaceView === 'history'}
          onClick={() => showWorkspace('history')}
          title={WORKSPACE_HELP.history}
        >
          History{noHistory && <span className="tab-warn" title="Nothing is being recorded — see the banner">!</span>}
        </button>
      </nav>
      <div className={`layout workspace-${workspaceView}`}>
        <div
          className={`left ${historyOrSplit && !leftOpen ? 'closed' : ''}`}
          style={historyOrSplit && leftOpen ? { flexBasis: leftWidth } : undefined}
        >
          <div className="tabs">
            <button className={leftTab === 'source' ? 'on' : ''} onClick={() => setLeftTab('source')}>Source</button>
            <button className={leftTab === 'history' ? 'on' : ''} onClick={() => setLeftTab('history')}>
              History{noHistory && <span className="tab-warn" title="Nothing is being recorded — see the banner">!</span>}
            </button>
            {workspaceView === 'split' && leftTab === 'source' && (
              <span className="seg split-editor-mode" title="Choose exact LaTeX source or source-preserving visual editing beside the PDF">
                <button className={editorMode === 'code' ? 'on' : ''} onClick={() => setEditorMode('code')}>Code</button>
                <button className={editorMode === 'visual' ? 'on' : ''} onClick={() => setEditorMode('visual')}>Live</button>
              </span>
            )}
            <span className="spacer" />
            {workspaceView === 'split' && <button className="ghost" onClick={() => setLeftOpen(false)} title="Collapse">«</button>}
          </div>
          <div className={`left-view ${leftTab === 'source' ? '' : 'view-hidden'}`}>
            <ErrorBoundary name="Source editor">
              <SourcePanel
                reloadTick={reloadTick}
                syncTarget={syncToSource}
                onSyncToPdf={onSyncToPdf}
                dead={status === 'stopped'}
                liveStatus={status}
                compileSeq={compileSeq}
                mode={editorMode}
                wide={workspaceView === 'code' || workspaceView === 'visual'}
                showModeToggle={false}
                preferredFile={pdfName}
                onModeChange={(mode) => {
                  setEditorMode(mode);
                  if (workspaceView === 'code' || workspaceView === 'visual') setWorkspaceView(mode);
                }}
              />
            </ErrorBoundary>
          </div>
          <div className={`left-view ${leftTab === 'history' ? '' : 'view-hidden'}`}>
            <ErrorBoundary name="History panel">
              <HistoryPanel
                reloadTick={reloadTick}
                onPreviewVersion={onPreviewVersion}
                showInlineDiff={workspaceView === 'split'}
                onSelectionChange={onHistorySelection}
                onDiffChange={onHistoryDiff}
                liveStatus={status}
              />
            </ErrorBoundary>
          </div>
        </div>
        {historyOrSplit && leftOpen && <Splitter dir="left" width={leftWidth} setWidth={setLeftWidth} min={MIN_LEFT} />}
        {historyOrSplit && !leftOpen && <button className="edge-open left-edge" onClick={() => setLeftOpen(true)} title="Open panel">»</button>}

        <div className="center">
          {errorLog && <pre className="compile-error">{errorLog}</pre>}
          {workspaceView === 'history' ? (
            <div className="history-detail">
              <div className="history-detail-toolbar">
                <div className="history-detail-title">
                  <strong>{historySelection?.title ?? 'Select a version'}</strong>
                  {historySelection && <span>{historySelection.subtitle}</span>}
                </div>
                <span className="spacer" />
                <span className="seg history-detail-mode" aria-label="History detail view">
                  <button
                    className={historyPane === 'diff' ? 'on' : ''}
                    aria-pressed={historyPane === 'diff'}
                    onClick={() => { setHistoryPane('diff'); setHistoricalPdf(null); }}
                  >
                    Code changes
                  </button>
                  <button
                    className={historyPane === 'pdf' ? 'on' : ''}
                    aria-pressed={historyPane === 'pdf'}
                    disabled={!historySelection?.hasPdf}
                    onClick={showSelectedHistoryPdf}
                    title={historySelection?.hasPdf ? 'Show the exact PDF saved with this version' : 'No stored PDF for this version'}
                  >
                    Rendered PDF
                  </button>
                </span>
              </div>
              {historyPane === 'diff' ? (
                !historySelection ? <div className="panel-hint">Choose a section and version on the left.</div>
                  : historyDiffDetail?.key !== historySelection.key || historyDiffDetail.loading
                    ? <div className="panel-hint">Loading precise code changes…</div>
                    : historyDiffDetail.diff
                      ? <DiffView diff={historyDiffDetail.diff} />
                      : <div className="panel-hint">No source text changed in this section at this checkpoint.</div>
              ) : (
                <ErrorBoundary name="Historical PDF view">
                  <PdfView
                    reloadTick={reloadTick}
                    pdfUrl={historicalPdf ? historicalPdfUrl(historicalPdf.sha) : '/latest.pdf'}
                    comments={[]}
                    onPages={setPages}
                    syncTarget={syncToPdf}
                  />
                </ErrorBoundary>
              )}
            </div>
          ) : (
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
                pdfCheckpoint={historicalPdf ? undefined : pdfCheckpoint}
              />
            </ErrorBoundary>
          )}
        </div>

        {rightOpen && <Splitter dir="right" width={rightWidth} setWidth={setRightWidth} min={MIN_RIGHT} />}
        <div className={`right ${rightOpen ? '' : 'closed'}`} style={rightOpen ? { flexBasis: rightWidth } : undefined}>
          <div className="tabs">
            <strong className="tab-title">Comments</strong>
            <span className="spacer" />
            <button className="ghost" onClick={() => setRightOpen(false)} title="Collapse">»</button>
          </div>
          <ErrorBoundary name="Comments panel">
            <CommentsPanel
              comments={comments}
              selectedId={selectedComment}
              onJump={jumpToComment}
              liveStatus={status}
              pdfCheckpoint={historicalPdf ? undefined : pdfCheckpoint}
            />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
