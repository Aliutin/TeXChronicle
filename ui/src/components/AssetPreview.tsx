import { useEffect, useRef, useState } from 'react';
import { assetFetchProblem, projectAssetUrl } from '../api';
import { pdfjs } from '../pdfRuntime';
import { PdfView } from './PdfView';

export interface AssetSelection {
  path: string;
  /** Source file containing \includegraphics, for paths relative to an include. */
  from?: string;
}

const PDF = /\.pdf$/i;
const IMAGE = /\.(?:png|jpe?g|gif|svg)$/i;
const EPS = /\.eps$/i;

const leafName = (path: string): string => path.split(/[\\/]/).pop() || path;

const NOT_FOUND = "PDF not found using this TeX project's figure paths";

/** An HTTP status the fetch already refused on, carried to the one catch that
 *  writes the message. Without it every failure — a corrupt file, a crashed
 *  pdf.js worker, a 500 — was reported as a missing one. */
class AssetHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(assetFetchProblem(status, body, NOT_FOUND));
    this.name = 'AssetHttpError';
  }
}

/** First page of a PDF figure for the lightweight Live document surface. The
 * full asset viewer below reuses PdfView; rendering every page for every figure
 * inside a paper would make Live slower than the compile it is meant to avoid. */
function PdfFirstPage({ url, name }: { url: string; name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [problem, setProblem] = useState(NOT_FOUND);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | undefined;
    let documentProxy: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | undefined;
    let renderTask: { promise: Promise<unknown>; cancel: () => void } | undefined;
    setState('loading');
    void (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new AssetHttpError(response.status, await response.text().catch(() => ''));
      const data = new Uint8Array(await response.arrayBuffer());
      if (cancelled) return;
      loadingTask = pdfjs.getDocument({ data });
      documentProxy = await loadingTask.promise;
      const page = await documentProxy.getPage(1);
      if (cancelled || !canvasRef.current) return;
      const base = page.getViewport({ scale: 1 });
      const available = canvasRef.current.parentElement?.clientWidth ?? 680;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const cssScale = Math.min(1.5, Math.max(0.35, available / base.width));
      const viewport = page.getViewport({ scale: cssScale * pixelRatio });
      const canvas = canvasRef.current;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.ceil(viewport.width / pixelRatio)}px`;
      canvas.style.height = `${Math.ceil(viewport.height / pixelRatio)}px`;
      renderTask = page.render({ canvas, viewport });
      await renderTask.promise;
      if (!cancelled) setState('ready');
    })().catch((error) => {
      if (!cancelled) {
        console.warn(`[TeXChronicle] could not render figure asset ${name}`, error);
        // The file arrived and pdf.js could not read it: a corrupt figure, or a
        // worker that died. Saying "not found" there sent people looking for a
        // path problem that was not there.
        setProblem(error instanceof AssetHttpError
          ? error.message
          : `This PDF could not be rendered: ${(error as Error)?.message ?? String(error)}`);
        setState('error');
      }
    });
    return () => {
      cancelled = true;
      try { renderTask?.cancel(); } catch { /* already complete */ }
      void loadingTask?.destroy().catch(() => {});
    };
  }, [name, url]);

  return (
    <div className={`asset-pdf-thumb asset-${state}`}>
      {state === 'loading' && <span>Opening PDF figure…</span>}
      {state === 'error' && <span title={problem}>{problem}</span>}
      <canvas ref={canvasRef} aria-label={`First page of ${name}`} />
    </div>
  );
}

export function LiveFigureAsset({ selection, refreshKey, onOpen }: {
  selection: AssetSelection;
  refreshKey: number;
  onOpen: (selection: AssetSelection) => void;
}) {
  const url = projectAssetUrl(selection.path, refreshKey, selection.from);
  const name = leafName(selection.path);
  const extension = name.includes('.') ? name.split('.').pop()!.toUpperCase() : 'FIG';
  const [fallback, setFallback] = useState<'none' | 'pdf' | 'failed'>('none');
  useEffect(() => setFallback('none'), [url]);

  const visual = PDF.test(selection.path) || fallback === 'pdf'
    ? <PdfFirstPage url={url} name={name} />
    : EPS.test(selection.path) || fallback === 'failed'
      ? <div className="live-asset-fallback"><span className="live-asset-type">{extension}</span><small>Preview unavailable; the compiled PDF remains exact</small></div>
      : <img src={url} alt={name} onError={() => setFallback(IMAGE.test(selection.path) ? 'failed' : 'pdf')} />;

  return (
    <button type="button" className="live-asset live-asset-preview" onClick={() => onOpen(selection)} title={`Open ${selection.path} in the asset viewer`}>
      <span className="live-asset-visual">{visual}</span>
      <span className="live-asset-name">{name}</span>
      <small>Click to inspect</small>
    </button>
  );
}

export function AssetPreview({ selection, refreshKey, onClose }: {
  selection: AssetSelection;
  refreshKey: number;
  onClose: () => void;
}) {
  const url = projectAssetUrl(selection.path, refreshKey, selection.from);
  const name = leafName(selection.path);
  const hasKnownExtension = PDF.test(selection.path) || IMAGE.test(selection.path) || EPS.test(selection.path);
  const [extensionlessPdf, setExtensionlessPdf] = useState(false);
  const kind = PDF.test(selection.path) || extensionlessPdf ? 'PDF' : IMAGE.test(selection.path) ? 'Image' : EPS.test(selection.path) ? 'EPS' : 'Figure';
  const [imageError, setImageError] = useState(false);
  useEffect(() => {
    setImageError(false);
    setExtensionlessPdf(false);
  }, [url]);

  // TeX commonly writes `\\includegraphics{plot}` and lets the compiler choose
  // plot.pdf or plot.png. Try the browser's image decoder first; if it rejects
  // the guarded asset, hand the same URL to pdf.js. This keeps extensionless
  // figures just as inspectable as files carrying an explicit suffix.
  const showPdf = PDF.test(selection.path) || (!hasKnownExtension && extensionlessPdf);
  const showImage = IMAGE.test(selection.path) || (!hasKnownExtension && !extensionlessPdf);

  return (
    <div className="asset-preview">
      <div className="editor-bar asset-preview-bar">
        <span className="asset-kind">{kind}</span>
        <span className="editor-file" title={selection.path}>{selection.path}</span>
        <span className="spacer" />
        <button onClick={onClose} title="Return to the open LaTeX source">← Back to source</button>
      </div>
      {showPdf ? (
        <PdfView
          reloadTick={refreshKey}
          pdfUrl={url}
          comments={[]}
          missingMessage="This PDF could not be found using the figure paths declared by this TeX project."
        />
      ) : showImage ? (
        <div className="asset-image-scroll">
          {!imageError
            ? <img src={url} alt={name} onError={() => hasKnownExtension ? setImageError(true) : setExtensionlessPdf(true)} />
            : <div className="asset-preview-error"><strong>Could not preview {name}</strong><span>The file was not found using this TeX project's figure paths.</span></div>}
        </div>
      ) : (
        <div className="asset-preview-error">
          <strong>{kind} cannot be displayed directly by the browser.</strong>
          <span>Convert it to PDF, PNG, JPEG, GIF, or SVG to preview it here. The compiled document remains unchanged.</span>
        </div>
      )}
    </div>
  );
}
