import { useEffect, useState } from 'react';
import { fetchOverleafLink, fetchDocTitle, recompile, type Status } from '../api';

const STATUS_LABEL: Record<Status, string> = {
  connecting: 'connecting…',
  connected: 'connected',
  compiling: 'compiling…',
  ok: '✓ up to date',
  error: '✖ compile error',
  disconnected: 'disconnected',
  stopped: '⚠ this window is no longer live',
};

export function Toolbar({
  status, pages, pdfName, reloadTick, commentsOpen, openCount, onToggleComments,
}: {
  status: Status; pages: number; pdfName: string; reloadTick: number;
  commentsOpen: boolean; openCount: number; onToggleComments: () => void;
}) {
  const [overleafUrl, setOverleafUrl] = useState<string | null>(null);
  const [hasPdf, setHasPdf] = useState(false);
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => { fetchOverleafLink().then(setOverleafUrl); }, []);
  useEffect(() => { if (status === 'ok') setHasPdf(true); }, [status]);
  // Refresh the \title after each compile (it may have been edited).
  useEffect(() => {
    let cancelled = false;
    fetchDocTitle(pdfName).then((next) => { if (!cancelled) setTitle(next); });
    return () => { cancelled = true; };
  }, [reloadTick, pdfName]);
  const compiling = status === 'compiling';
  // Nothing is listening on this port any more, so these would fail silently —
  // and a button that looks live is part of what makes a dead window pass for one.
  const dead = status === 'stopped';

  const downloadPdf = async () => {
    const res = await fetch('/latest.pdf?t=' + Date.now());
    if (!res.ok) return;
    // Auto-name: <title|main>_YYYY-MM-DD_HHMMSS.pdf — unique each time, no manual renaming.
    const base = (title || pdfName || 'paper').replace(/[^\w一-龥-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'paper';
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `${base}_${stamp}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const exportZip = () => {
    const a = document.createElement('a');
    a.href = '/export.zip'; a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  };

  return (
    <div className="toolbar">
      <img className="brand-mark" src="/app/favicon.svg" alt="" width={22} height={22} />
      <strong className="brand" title={title ?? undefined}>{title ?? 'MagicTeX'}</strong>
      <button className="recompile on" onClick={() => void recompile()} disabled={compiling || dead}
              title={dead ? 'This window is no longer connected to a server' : 'Compile now'}>
        {compiling ? '⟳ Compiling…' : '⟳ Recompile'}
      </button>
      <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
      {pages > 0 && <span className="meta">{pages} page{pages === 1 ? '' : 's'}</span>}
      <span className="spacer" />
      <button
        className={`comments-toggle ${commentsOpen ? 'on' : ''} ${openCount > 0 ? 'has-open' : ''}`}
        onClick={onToggleComments}
        title={commentsOpen ? 'Hide the comments panel' : 'Show the comments panel'}
      >
        💬 Comments{openCount > 0 ? ` · ${openCount}` : ''}
      </button>
      <button onClick={exportZip} disabled={dead} title="Download a clean Overleaf-ready .zip (build inputs only)">⬆ Export .zip</button>
      <button onClick={downloadPdf} disabled={!hasPdf || dead} title="Download the compiled PDF">⤓ Download PDF</button>
      {overleafUrl && (
        <a className="linkbtn" href={overleafUrl} target="_blank" rel="noopener"
           title="One-click open in Overleaf — works only if your GitHub repo is public">
          Open in Overleaf ↗
        </a>
      )}
    </div>
  );
}
