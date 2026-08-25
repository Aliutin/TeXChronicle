// Center panel: renders /latest.pdf with pdf.js (canvas + selectable text
// layer), re-renders on WS reload, and hosts the LiquidText-style interaction:
// select text on a page → floating "Comment" composer → anchored highlight.
// A control strip provides Overleaf-style zoom + page navigation; the render
// scale is state, and highlights are stored at scale 1 and projected by it.
//
// Pages are structural, canvases are not. Every page gets a wrapper of exactly
// the right size and its own text layer the moment the document opens — those
// are what scroll position, page navigation, search, selection and comment
// anchoring are built on, and they have to exist for the whole document. The
// canvas inside a wrapper is painted only while the page is near the viewport
// (see ../pageWindow), because keeping every page's pixels is what made a long
// thesis unopenable.
import { useCallback, useEffect, useRef, useState } from 'react';
import { pdfjs } from '../pdfRuntime';
import { assetFetchProblem, createComment, inverseSyncTeX, type Comment, type SyncTeXSourceLocation } from '../api';
import { normalize, phrase } from '../sync';
import { groupLines, columnsFromTextItems } from '../lines';
import { pageRenderWindow, type PageRange } from '../pageWindow';

const MIN_SCALE = 0.4;
const MAX_SCALE = 3;
/** Viewports of pages kept painted above and below the visible band. */
const RENDER_SLACK = 2;

type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type PdfRenderTask = ReturnType<PdfPage['render']>;

/** One page of the open document: its DOM, its pdf.js page, and what its canvas
 *  currently holds. */
interface PageEntry {
  number: number;
  page: PdfPage;
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textLayer: InstanceType<typeof pdfjs.TextLayer>;
  /** The scale the canvas holds or is being painted at; 0 when it is blank. */
  drawnScale: number;
  /** The scale the text layer was last laid out for. */
  textScale: number;
  task: PdfRenderTask | null;
}

interface Draft { page: number; quote: string; rects: { x: number; y: number; w: number; h: number }[]; x: number; y: number }
interface SyncTarget { text: string; nonce: number }

export function PdfView({
  reloadTick, pdfUrl = '/latest.pdf', historicalLabel, onReturnLatest,
  comments, onPages, onSelectComment, onSyncToSource, syncTarget, missingMessage, pdfCheckpoint,
}: {
  reloadTick: number;
  pdfUrl?: string;
  historicalLabel?: string;
  onReturnLatest?: () => void;
  comments: Comment[];
  onPages?: (n: number) => void;
  onSelectComment?: (id: string) => void;
  onSyncToSource?: (target: { text: string } & Partial<SyncTeXSourceLocation>) => void;
  syncTarget?: SyncTarget | null;
  missingMessage?: string;
  /** Checkpoint that produced the live PDF. Frozen rectangles are safe only on
   * that exact version; later versions must successfully re-anchor the quote. */
  pdfCheckpoint?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string>('waiting for first compile…');
  // A note is either prose for the reader or a failure report to be copied out.
  // They want opposite typography, so the pane needs to know which it is holding.
  const [noteIsReport, setNoteIsReport] = useState(false);
  const [renderTick, setRenderTick] = useState(0); // bumps after pages exist in the DOM
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftText, setDraftText] = useState('');
  const [scale, setScale] = useState(1.5);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const baseWidth = useRef(0); // page-1 width at scale 1, for fit-to-width
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const reverseSyncSeq = useRef(0);
  // The pages of the document currently on screen. Owned by the load effect and
  // read by everything that paints, zooms or releases one.
  const entriesRef = useRef<PageEntry[]>([]);
  // Which load these entries belong to. A stray callback from a superseded run
  // must not report anything, and must not paint into a page nobody can see.
  const loadSeq = useRef(0);

  /** Put a page's wrapper at `scaleNow`. The text layer comes along by itself:
   *  pdf.js positions every span as a percentage of the page box, so a page
   *  that changes size takes its spans with it. */
  const layout = useCallback((entry: PageEntry, scaleNow: number) => {
    const viewport = entry.page.getViewport({ scale: scaleNow });
    entry.wrap.style.width = `${viewport.width}px`;
    entry.wrap.style.height = `${viewport.height}px`;
    // Read back by the highlight projection and by the click→SyncTeX map, so it
    // has to change with the page rather than with the next repaint.
    entry.wrap.style.setProperty('--scale-factor', String(scaleNow));
  }, []);

  /** Paint this page's canvas at the current scale, if it isn't already. */
  const paint = useCallback((entry: PageEntry, seq: number) => {
    const scaleNow = scaleRef.current;
    if (entry.textScale !== scaleNow) {
      // Re-lays out the spans the layer already holds; no text is fetched or
      // parsed again. Done here, for the pages being painted, rather than for
      // the whole document on every zoom click: `update` measures each span
      // against a canvas context, which on a 300-page paper is hundreds of
      // thousands of measurements for one press of the − button.
      entry.textLayer.update({ viewport: entry.page.getViewport({ scale: scaleNow }) });
      entry.textScale = scaleNow;
    }
    if (entry.drawnScale === scaleNow) return; // painted, or being painted, at this size
    entry.task?.cancel();
    const viewport = entry.page.getViewport({ scale: scaleNow });
    const canvas = entry.canvas;
    // Floor, as assigning the raw float always did: a canvas wider than the
    // wrapper it sits in overflows it by a fraction of a pixel, and every
    // highlight is measured against that wrapper's box.
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    entry.drawnScale = scaleNow;
    // pdf.js v5 made `canvas` the required parameter and demoted
    // `canvasContext` to a back-compat alias, so pass the element.
    const task = entry.page.render({ canvas, viewport });
    entry.task = task;
    task.promise.then(
      () => { if (entry.task === task) entry.task = null; },
      (error: unknown) => {
        if (entry.task !== task) return; // superseded by a zoom or a release
        entry.task = null;
        entry.drawnScale = 0; // nothing on the canvas; let it be repainted
        // A cancelled render is the normal way out of a zoom or a scroll, and
        // saying so in the console every time buries the ones that matter.
        const name = (error as { name?: string })?.name;
        if (seq === loadSeq.current && name !== 'RenderingCancelledException') {
          console.warn(`[TeXChronicle] page ${entry.number} did not render`, error);
        }
      },
    );
  }, []);

  /** Give this page's pixels back. The wrapper keeps its size, so nothing the
   *  reader can see or scroll to moves. */
  const release = useCallback((entry: PageEntry) => {
    if (entry.drawnScale === 0 && !entry.task) return;
    entry.task?.cancel();
    entry.task = null;
    entry.drawnScale = 0;
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    // Without this pdf.js keeps the page's operator list and fonts alive, which
    // is the other half of what made scrolling a long paper grow without bound.
    entry.page.cleanup();
  }, []);

  /** Bring the painted pages back in line with where the reader is looking.
   *  Answers with the range it decided on, or null when there was nothing to
   *  measure yet. */
  const reconcile = useCallback((): PageRange | null => {
    const scroller = scrollRef.current;
    const entries = entriesRef.current;
    if (!scroller || !entries.length) return null;
    // A rebuild after a recompile assembles its pages in a fragment and swaps
    // them in at the end. A detached element measures as 0×0, and a list of
    // zero-height pages all overlap the viewport — which would paint the entire
    // document at once, the exact thing this is here to prevent.
    if (!entries[0].wrap.isConnected) return null;
    const seq = loadSeq.current;
    // Every measurement first, then every mutation: interleaving them makes the
    // browser re-lay-out the whole page list once per page.
    const boxes = entries.map((entry) => ({ top: entry.wrap.offsetTop, height: entry.wrap.offsetHeight }));
    const band = pageRenderWindow(boxes, scroller.scrollTop, scroller.clientHeight, RENDER_SLACK);
    entries.forEach((entry, index) => {
      if (index >= band.first && index <= band.last) paint(entry, seq);
      else release(entry);
    });
    return band;
  }, [paint, release]);

  // ── Open the PDF: one wrapper and one text layer per page ───────────────
  useEffect(() => {
    let cancelled = false;
    const seq = ++loadSeq.current;
    const entries: PageEntry[] = [];
    entriesRef.current = entries;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | undefined;
    // What the render was doing when it threw. A rendering failure reported as
    // bare `String(e)` cost three rounds of guessing on a real bug: the message
    // "TypeError: undefined is not a function (near '...e of t...')" named no
    // page, no step and no stack, so every reading of it was a guess. Whatever
    // fails next should say where.
    let step = 'starting';
    (async () => {
      const container = pagesRef.current;
      const scroller = scrollRef.current;
      if (!container || !scroller) return;
      setNoteIsReport(false);
      setNote('Loading PDF…');
      step = `fetching ${pdfUrl}`;
      const res = await fetch(`${pdfUrl}${pdfUrl.includes('?') ? '&' : '?'}t=${Date.now()}`);
      if (cancelled) return;
      if (!res.ok) {
        setNoteIsReport(false);
        // A 404 is "there is no PDF here" — the compile has not run yet, or the
        // figure path is wrong. Anything else is the server failing, and saying
        // "no PDF yet" about a 500 sent people to click Recompile forever.
        setNote(assetFetchProblem(
          res.status,
          await res.text().catch(() => ''),
          missingMessage ?? 'No PDF yet — wait for the initial compile or click Recompile.',
        ));
        return;
      }
      const data = new Uint8Array(await res.arrayBuffer());
      if (cancelled) return;
      step = `parsing PDF (${data.length} bytes)`;
      setNote(`Opening PDF (${Math.max(1, Math.round(data.length / 1024 / 1024))} MB)…`);
      loadingTask = pdfjs.getDocument({ data });
      const doc = await loadingTask.promise;
      if (cancelled) return;
      setNumPages(doc.numPages);
      onPages?.(doc.numPages);
      // Preserve scroll position as a ratio so zoom keeps you in place.
      const ratio = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
      // Preserve already-visible pages during a recompile or zoom, then swap
      // the replacement in at once. On the first load there is nothing useful
      // to preserve, so publish each finished page immediately. Large papers
      // used to look completely blank until all 80+ pages had rendered.
      const hadPages = container.childElementCount > 0;
      const next = document.createDocumentFragment();
      // Once the opening screenful has been decided there is nothing for the
      // pages below it to change until the reader moves, and re-measuring the
      // whole list after every appended page is what would make a long document
      // slower to open, not faster.
      let bandSettled = false;
      for (let i = 1; i <= doc.numPages; i++) {
        if (cancelled) return;
        if (hadPages || i === 1) setNote(`Rendering page ${i} of ${doc.numPages}…`);
        step = `page ${i}/${doc.numPages}: getPage`;
        const pg = await doc.getPage(i);
        if (cancelled) return;
        if (i === 1) baseWidth.current = pg.getViewport({ scale: 1 }).width;
        const vp = pg.getViewport({ scale: scaleRef.current });
        const wrap = document.createElement('div');
        wrap.className = 'page';
        wrap.dataset.page = String(i);
        wrap.style.width = `${vp.width}px`;
        wrap.style.height = `${vp.height}px`;
        wrap.style.setProperty('--scale-factor', String(scaleRef.current));
        const canvas = document.createElement('canvas');
        // Deliberately empty. The wrapper above already holds this page's final
        // size, so the document's full height, every scroll offset and every
        // highlight coordinate are correct before a single pixel is drawn —
        // which is what lets the drawing wait until the page is nearly in view.
        canvas.width = 0;
        canvas.height = 0;
        wrap.appendChild(canvas);
        const textDiv = document.createElement('div');
        textDiv.className = 'textLayer';
        wrap.appendChild(textDiv);
        const hlDiv = document.createElement('div');
        hlDiv.className = 'hl-layer';
        wrap.appendChild(hlDiv);
        next.appendChild(wrap);
        // The text layer is built for EVERY page, near the viewport or not: it
        // is what comment anchoring, the source↔PDF jump, browser search and
        // text selection all read. A page without one is a page where a
        // reviewer's comment silently loses its highlight.
        step = `page ${i}/${doc.numPages}: text layer`;
        const textLayer = new pdfjs.TextLayer({ textContentSource: pg.streamTextContent(), container: textDiv, viewport: vp });
        await textLayer.render();
        if (cancelled) return;
        // Column boundaries come from the PDF's own coordinates, not from the
        // rendered text layer. That layer is an approximation which degrades at
        // small font sizes — spans overflow into their neighbours and fill the
        // gutter — so detecting columns from the DOM answered differently at
        // each zoom of the same document: two boundaries at 150%, one at 124%,
        // none at 102%, at which point a highlight spanned the whole page.
        // Computed once per page in scale-1 units, projected where it's used.
        //
        // Wrapped, and deliberately: this is an input to highlight placement, not
        // to rendering. Shipped without the guard it threw on a document whose
        // text content carries entries with no `str` — pdf.js mixes marked-content
        // markers in among the text items — and took the whole PDF pane down with
        // it. A worse failure than the misplaced highlight it was added to fix.
        // Without boundaries the grouping falls back to inferring them, which is
        // what every release before this one did.
        //
        // `step` is still set inside the guard. Nothing here can reach the outer
        // report any more, but the warning below is the only trace a skipped page
        // leaves, and "which page, at which stage" is the part worth having in it.
        step = `page ${i}/${doc.numPages}: column detection`;
        try {
          const content = await pg.getTextContent();
          const cols = columnsFromTextItems(content.items, pg.getViewport({ scale: 1 }).height);
          wrap.dataset.columns = JSON.stringify(cols);
        } catch (e) {
          console.warn(`[texchronicle] column detection skipped — ${step}`, e);
        }
        // Everything this run needs from the page for now is done. Without
        // cleanup pdf.js keeps each page's operator list and fonts alive, so
        // scrolling a long paper grew memory until the tab was unusable. A page
        // that is about to be painted defers this until its render finishes,
        // and one painted later simply asks the worker again.
        pg.cleanup();
        // Three awaits stand between the guard at the top of this iteration and
        // this line. A superseded run that reaches here appends a page from the
        // OLD document into the container the new run is filling: two nodes with
        // data-page="1", and goToPage jumps to whichever comes first.
        if (cancelled) return;
        const entry: PageEntry = { number: i, page: pg, wrap, canvas, textLayer, drawnScale: 0, textScale: vp.scale, task: null };
        entries.push(entry);
        // A zoom during a long load moves the scale out from under the pages
        // already built; the effect that handles it only sees the ones pushed
        // by then, so this page catches itself up.
        if (scaleRef.current !== vp.scale) layout(entry, scaleRef.current);
        if (!hadPages) {
          // Moving the wrapper out of the fragment makes the page visible;
          // later pages continue rendering without covering page 1 with a
          // blocking progress message.
          container.appendChild(wrap);
          if (i === 1) {
            setNote('');
            setRenderTick((t) => t + 1);
          }
          // Now that this page is in the document it can be measured, so the
          // opening screenful is painted while the rest of the text layers are
          // still being built rather than after all of them.
          if (!bandSettled) {
            const band = reconcile();
            bandSettled = Boolean(band && band.last < entries.length - 1);
          }
        }
      }
      if (cancelled) return;
      if (hadPages) container.replaceChildren(next);
      setNote('');
      setRenderTick((t) => t + 1);
      scroller.scrollTop = ratio * scroller.scrollHeight;
      // Pages swapped in as one fragment could not be measured until now.
      reconcile();
    })().catch((e) => {
      // A superseded run must not speak. Every other exit in this effect is gated
      // on `cancelled`; the catch was not, so a run abandoned by a zoom click or
      // a reload could reject AFTER a newer run had rendered fine and paint a
      // full failure report over it — styled, deliberately, to be screenshotted
      // into a bug report. The reporting work manufacturing false reports.
      if (cancelled) { console.warn('[TeXChronicle] superseded render failed during: ' + step, e); return; }
      // The console gets the error object itself, so DevTools can offer a real
      // clickable stack; the pane gets a report someone can screenshot. A
      // screenshot is what actually reaches a maintainer, so it has to carry
      // enough on its own — which step, which browser, which pdf.js.
      console.error('[TeXChronicle] PDF render failed during: ' + step, e);
      const err = e as { message?: string; stack?: string; name?: string };
      // pdf.js re-creates worker exceptions on this side of a postMessage, and a
      // stack does not survive that trip — so for the errors most worth
      // diagnosing there is nothing to print. Say so, rather than leaving a gap
      // that reads like the report simply forgot: "no stack" is itself the clue
      // that the failure happened inside the worker, not in this file.
      const stack = err?.stack
        ? '\n' + err.stack.split('\n').slice(0, 6).join('\n')
        : '\n(no stack — the error crossed the pdf.js worker boundary, which does not carry one)';
      setNoteIsReport(true);
      setNote(
        `render failed while ${step}\n\n${err?.name ?? 'Error'}: ${err?.message ?? String(e)}${stack}` +
        `\n\npdf.js ${pdfjs.version} · ${navigator.userAgent}`,
      );
    });
    return () => {
      cancelled = true;
      for (const entry of entries) { entry.task?.cancel(); entry.page.cleanup(); }
      if (entriesRef.current === entries) entriesRef.current = [];
      // With workerSrc each loading task owns its worker. Release it when a PDF
      // asset is closed or a reload starts a replacement render; otherwise
      // checking several figures leaves one worker and document transport alive
      // per file.
      void loadingTask?.destroy().catch(() => {});
    };
    // Deliberately without `scale`. A zoom used to re-enter all of this: refetch
    // the bytes over HTTP, hand them to a fresh worker, reparse the document and
    // rebuild every page — for a change in how large the same pages are drawn.
    // On a long paper that was seconds of work and a visibly empty pane per
    // click. The effect below resizes what is already open instead.
  }, [reloadTick, onPages, pdfUrl, missingMessage, layout, reconcile]);

  // ── Zoom: resize the open document, never reload it ─────────────────────
  useEffect(() => {
    const entries = entriesRef.current;
    const scroller = scrollRef.current;
    if (!entries.length || !scroller) return;
    // Preserve the reading position as a ratio, as the loader does.
    const ratio = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
    // Resizing every wrapper is cheap and has to be complete: a page below the
    // fold still contributes its height to where the pages after it sit, and a
    // comment anchored on it is measured against its box.
    for (const entry of entries) layout(entry, scale);
    scroller.scrollTop = ratio * scroller.scrollHeight;
    reconcile();
    // Geometry has moved, so the highlights have to be projected again. This
    // effect is declared before the one that draws them, so it sees the new
    // sizes rather than the ones being replaced.
    setRenderTick((t) => t + 1);
  }, [scale, layout, reconcile]);

  // ── Track which page is in view, and what is worth painting ─────────────
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mid = scroller.scrollTop + scroller.clientHeight / 2;
        let best = 1;
        for (const page of pagesRef.current?.querySelectorAll('.page') ?? []) {
          const el = page as HTMLElement;
          if (el.offsetTop <= mid) best = Number(el.dataset.page);
        }
        setCurrentPage(best);
        reconcile();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    // Dragging a side panel changes what fits on screen without producing a
    // single scroll event, and a page that became visible that way would stay
    // blank until the reader happened to scroll.
    const resize = new ResizeObserver(() => reconcile());
    resize.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
      resize.disconnect();
    };
  }, [renderTick, reconcile]);

  const zoomBy = (f: number) => setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(s * f).toFixed(3))));
  const fitWidth = () => {
    const scroller = scrollRef.current;
    if (!scroller || !baseWidth.current) return;
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, +((scroller.clientWidth - 40) / baseWidth.current).toFixed(3))));
  };
  const goToPage = (n: number) => {
    const p = Math.min(Math.max(1, n), numPages || 1);
    pagesRef.current?.querySelector(`.page[data-page="${p}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ── Click PDF → genuine inverse SyncTeX, with visible-text fallback ─────
  const onClick = async (e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // a drag-select is a comment, not a sync
    if (!onSyncToSource) return;
    const pageEl = (e.target as HTMLElement).closest('.page') as HTMLElement | null;
    if (!pageEl) return;

    // The text layer can contain transformed spans whose boxes overlap. Prefer
    // the actual event target; if the click landed in a gap, retain a nearby span
    // only for the fallback. SyncTeX itself does not need text at all.
    let span = (e.target as HTMLElement).closest('.textLayer span') as HTMLElement | null;
    if (!span) {
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of pageEl.querySelectorAll('.textLayer span')) {
        const r = candidate.getBoundingClientRect();
        const dx = e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0;
        const dy = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
        const distance = Math.hypot(dx, dy);
        if (distance < best) { best = distance; span = candidate as HTMLElement; }
      }
      if (best > 24) span = null;
    }
    let text = span?.textContent ?? '';
    let n = span?.nextElementSibling ?? null;
    while (n && normalize(text).split(' ').filter(Boolean).length < 6) {
      text += ' ' + (n.textContent ?? '');
      n = n.nextElementSibling;
    }

    const page = Number(pageEl.dataset.page);
    const pageBox = pageEl.getBoundingClientRect();
    const renderedScale = parseFloat(getComputedStyle(pageEl).getPropertyValue('--scale-factor')) || scaleRef.current;
    // SyncTeX's CLI uses big points (72 dpi) from the top-left. pdf.js viewport
    // pixels at scale 1 use that same unit, so divide only by the render scale.
    const x = (e.clientX - pageBox.left) / renderedScale;
    const y = (e.clientY - pageBox.top) / renderedScale;
    const seq = ++reverseSyncSeq.current;
    const location = await inverseSyncTeX(page, x, y);
    if (seq !== reverseSyncSeq.current) return; // a newer click already won
    if (location) onSyncToSource({ text, ...location });
    else if (normalize(text)) onSyncToSource({ text });
  };

  // ── Source → PDF: scroll the matching page/word into view and flash it ──
  useEffect(() => {
    const container = pagesRef.current;
    if (!container || !syncTarget) return;
    const target = phrase(syncTarget.text, 6);
    if (!target) return;
    for (const page of container.querySelectorAll('.page')) {
      const spans = Array.from(page.querySelectorAll('.textLayer span')) as HTMLElement[];
      let concat = '';
      const map: { start: number; el: HTMLElement }[] = [];
      for (const s of spans) {
        const norm = normalize(s.textContent ?? '');
        if (!norm) continue;
        map.push({ start: concat.length, el: s });
        concat += norm + ' ';
      }
      const at = concat.indexOf(target);
      if (at < 0) continue;
      const hit = [...map].reverse().find((m) => m.start <= at)?.el ?? spans[0];
      hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
      hit.classList.add('sync-flash');
      setTimeout(() => hit.classList.remove('sync-flash'), 1400);
      break;
    }
  }, [syncTarget, renderTick]);

  // ── Project highlights onto pages ───────────────────────────────────────
  useEffect(() => {
    const container = pagesRef.current;
    if (!container) return;
    for (const layer of container.querySelectorAll('.hl-layer')) layer.innerHTML = '';

    const box = (layer: Element, c: Comment, statusCls: string, left: number, top: number, w: number, h: number) => {
      const el = document.createElement('div');
      el.className = `hl ${statusCls}`;
      el.dataset.id = c.id;
      el.title = c.text;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.addEventListener('click', () => onSelectComment?.(c.id));
      layer.appendChild(el);
    };

    // Re-anchor a quote onto a page's *live* text layer, returning boxes at the
    // current glyph positions — so a highlight follows the text through
    // recompiles/reflows instead of sitting at frozen coordinates. We anchor by a
    // head phrase and a tail phrase (not the whole quote), and try progressively
    // shorter phrases (8→3 words) so it still lands when the AI rewrote words near
    // an edge; only if even a 3-word head is gone do we give up (→ null) and let
    // the caller fall back to the stored rects.
    const anchor = (concat: string, words: string[], fromStart: boolean): number => {
      for (const n of [8, 6, 4, 3]) {
        const ph = (fromStart ? words.slice(0, n) : words.slice(-n)).join(' ');
        if (words.length < n && n > 3) continue; // don't retry the same whole-string phrase
        const idx = fromStart ? concat.indexOf(ph) : concat.lastIndexOf(ph);
        if (idx >= 0) return fromStart ? idx : idx + ph.length;
      }
      return -1;
    };
    interface Span { start: number; len: number; l: number; t: number; w: number; h: number; el: HTMLElement }

    // Map each character of normalize()'d text back to its index in the raw
    // text, mirroring what normalize does: alphanumerics stand for themselves,
    // each run of everything else collapses to ONE space (indexed at the run's
    // first character), and leading/trailing runs vanish to the trim().
    const normToRaw = (raw: string): number[] => {
      const map: number[] = [];
      let inSep = true; // a leading separator run is trimmed away
      for (let i = 0; i < raw.length; i++) {
        if (/[a-z0-9]/.test(raw[i].toLowerCase())) { map.push(i); inSep = false; }
        else if (!inSep) { map.push(i); inSep = true; }
      }
      if (inSep) map.pop(); // the trailing space trim() removes
      return map;
    };

    // Where inside a span does normalized offset `localNorm` actually fall?
    // hits() works at span granularity, but pdf.js emits spans covering many
    // words at once, so taking a span's own edge put the highlight's start up to
    // a whole span early. A Range over the text node gives the true glyph
    // position.
    //
    // Everything here is measured in the page's VISUAL space — client rects,
    // minus the page's own origin. It used to mix spaces: offsetWidth for the
    // span boxes and a client-rect fraction reapplied to them for the edges.
    // pdf.js gives each span a `transform: scaleX(k)` so the text matches the
    // PDF's advance widths, and offsetWidth does not include that scale — so
    // every span was as wide as its layout box rather than as wide as its
    // glyphs. k is recomputed at each zoom level, which is why the highlights
    // moved when you changed zoom rather than being consistently wrong.
    const edgeInSpan = (s: Span, localNorm: number, side: 'left' | 'right', pageLeft: number): number | null => {
      const node = s.el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return null;
      const raw = node.textContent ?? '';
      const map = normToRaw(raw);
      const rawIdx = localNorm <= 0 ? 0 : localNorm >= map.length ? raw.length : map[localNorm];
      if (side === 'left' ? rawIdx >= raw.length : rawIdx <= 0) return null;
      const range = document.createRange();
      if (side === 'left') { range.setStart(node, rawIdx); range.setEnd(node, raw.length); }
      else { range.setStart(node, 0); range.setEnd(node, rawIdx); }
      const rect = range.getBoundingClientRect();
      if (!rect.width) return null;
      return (side === 'left' ? rect.left : rect.right) - pageLeft;
    };
    // groupLines lives in ../lines: knowing each line's FULL extent (not just the
    // matched words on it) is what lets interior lines get a flush box below, and
    // that same property is what made a two-column page paint across the gutter
    // until the grouping learned about columns. Extracted so the geometry can be
    // unit-tested with synthetic coordinates.
    const liveBoxes = (page: Element, quote: string): { l: number; t: number; w: number; h: number }[] | null => {
      const norm = normalize(quote);
      if (!norm) return null;
      const words = norm.split(' ').filter(Boolean);
      let concat = '';
      const all: Span[] = [];
      // Client rects, not offsets: pdf.js scales each span with a transform that
      // offsetWidth ignores, so offset geometry describes the layout box rather
      // than the glyphs. `.page` is position:relative with no border, so
      // subtracting its origin lands in exactly the coordinate space `.hl-layer`
      // (inset: 0) positions boxes in.
      const pageBox = page.getBoundingClientRect();
      for (const s of page.querySelectorAll('.textLayer span')) {
        const el = s as HTMLElement;
        const n = normalize(el.textContent ?? '');
        if (!n) continue;
        const r = el.getBoundingClientRect();
        all.push({
          start: concat.length, len: n.length,
          l: r.left - pageBox.left, t: r.top - pageBox.top, w: r.width, h: r.height,
          el,
        });
        concat += n + ' ';
      }
      // Stored at scale 1 by the renderer; project to what is on screen now.
      const cols: number[] = (() => {
        try { return JSON.parse((page as HTMLElement).dataset.columns ?? '[]') as number[]; } catch { return []; }
      })().map((x) => x * (parseFloat(getComputedStyle(page).getPropertyValue('--scale-factor')) || 1));
      const at = anchor(concat, words, true);
      if (at < 0) return null;
      const tailEnd = anchor(concat, words, false);
      const end = tailEnd > at ? tailEnd : Math.min(concat.length, at + norm.length);
      const hits = (line: { spans: Span[] }) => line.spans.filter((s) => s.start < end && s.start + s.len > at);

      // Shape it like a text selection: the first touched line starts at the
      // match and runs to the LINE's own right edge; the last touched line runs
      // from the line's own left edge to the match's end; any line fully between
      // them is flush, full width, top to bottom — none of that depends on any
      // single word's box, so font-metric quirks on interior words can't
      // fragment the highlight the way per-word boxes did.
      const touched = groupLines(all, cols).filter((L) => hits(L).length > 0);
      if (!touched.length) return null;
      return touched.map((L, i) => {
        let l = L.l, r = L.r;
        if (i === 0) {
          // Prefer the exact glyph position of the matched word; fall back to
          // the span edge when the offset lands in the gap between two spans or
          // the node isn't measurable.
          const host = hits(L).find((s) => s.start <= at && at < s.start + s.len);
          l = (host && edgeInSpan(host, at - host.start, 'left', pageBox.left)) ?? Math.min(...hits(L).map((s) => s.l));
        }
        if (i === touched.length - 1) {
          const host = hits(L).find((s) => s.start < end && end <= s.start + s.len);
          r = (host && edgeInSpan(host, end - host.start, 'right', pageBox.left)) ?? Math.max(...hits(L).map((s) => s.l + s.w));
        }
        return { l, t: L.t, w: r - l, h: L.b - L.t };
      });
    };

    for (const c of comments) {
      // accepted → yellow, suggested → purple dashed, resolved → GREEN (the AI
      // did it, awaiting your review). Closing a resolved comment removes it and
      // its highlight — that's the "human-confirmed" step, so colors don't pile up.
      const statusCls = c.restoreReview ? 'hl-review' : c.status === 'resolved' ? 'hl-resolved' : c.status === 'suggested' ? 'hl-suggested' : '';
      // `?.` is deliberate: the store normalizes this, but the PDF pane must not
      // be the thing that dies if a comment ever reaches it without coords.
      if (c.rects?.length) {
        // Prefer re-anchoring onto the live text so the box tracks reflow; only
        // fall back to the frozen rects (projected by scale) if the text is gone.
        const pageEl = container.querySelector(`.page[data-page="${c.page}"]`);
        const layer = pageEl?.querySelector('.hl-layer');
        if (!layer) continue;
        const boxes = liveBoxes(pageEl!, c.quote);
        // Frozen rectangles are only trustworthy on the version they were taken
        // from, so a comment made against a KNOWN OTHER checkpoint keeps none.
        // The test used to be the other way round — draw only when both
        // checkpoints are known and equal — which meant a machine with no
        // history, where nothing ever carries a checkpoint, drew no highlight
        // for any comment whose quote had moved. The reader saw comments in the
        // panel with nothing marked in the PDF and no explanation for it.
        const staleRects = Boolean(c.createdCheckpoint && pdfCheckpoint && c.createdCheckpoint !== pdfCheckpoint);
        if (boxes) for (const b of boxes) box(layer, c, statusCls, b.l, b.t, b.w, b.h);
        else if (!staleRects) {
          for (const r of c.rects) box(layer, c, statusCls, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
        }
        continue;
      }
      // Reviewer/agent comment posted without PDF coords → find the quote anywhere.
      for (const page of container.querySelectorAll('.page')) {
        const boxes = liveBoxes(page, c.quote);
        if (!boxes) continue;
        const layer = page.querySelector('.hl-layer')!;
        for (const b of boxes) box(layer, c, statusCls, b.l, b.t, b.w, b.h);
        break;
      }
    }
  }, [comments, renderTick, scale, onSelectComment, pdfCheckpoint]);

  // ── Selection → comment composer ────────────────────────────────────────
  const onMouseUp = () => {
    if (historicalLabel) return; // comments belong to the live source/PDF pair
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const quote = sel.toString().trim();
    if (!quote) return;
    const range = sel.getRangeAt(0);
    const pageEl = (range.startContainer.parentElement as HTMLElement | null)?.closest('.page') as HTMLElement | null;
    if (!pageEl || !scrollRef.current) return;
    const pageRect = pageEl.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 1 && r.height > 1)
      .filter((r) => r.left >= pageRect.left - 2 && r.right <= pageRect.right + 2 && r.top >= pageRect.top - 2 && r.bottom <= pageRect.bottom + 2)
      .slice(0, 40)
      .map((r) => ({ x: (r.left - pageRect.left) / scale, y: (r.top - pageRect.top) / scale, w: r.width / scale, h: r.height / scale }));
    if (!rects.length) return;
    const scroller = scrollRef.current;
    const scRect = scroller.getBoundingClientRect();
    const last = range.getClientRects()[range.getClientRects().length - 1];
    const rawX = last.right - scRect.left + scroller.scrollLeft;
    const rawY = last.bottom - scRect.top + scroller.scrollTop + 6;
    const x = Math.max(scroller.scrollLeft + 8, Math.min(rawX, scroller.scrollLeft + scroller.clientWidth - 316));
    const y = Math.min(rawY, scroller.scrollTop + scroller.clientHeight - 40);
    setDraft({ page: Number(pageEl.dataset.page), quote: quote.slice(0, 600), rects, x, y });
    setDraftText('');
  };

  const submitDraft = async () => {
    if (!draft || !draftText.trim()) return;
    await createComment({ page: draft.page, quote: draft.quote, rects: draft.rects, text: draftText.trim() });
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  };

  const pct = Math.round(scale * 100);

  return (
    <div className="pdf-wrap">
      <div className="pdf-toolbar">
        {historicalLabel && (
          <div className="historical-pdf" title="This is the exact PDF stored for a section version">
            <span>History: {historicalLabel}</span>
            <button className="ghost" onClick={onReturnLatest}>Back to latest</button>
          </div>
        )}
        <div className="pager">
          <button className="ghost" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} title="Previous page">▲</button>
          <input
            className="page-input"
            value={currentPage}
            onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '')); if (n) setCurrentPage(n); }}
            onKeyDown={(e) => { if (e.key === 'Enter') goToPage(currentPage); }}
            onBlur={() => goToPage(currentPage)}
          />
          <span className="of">/ {numPages || '—'}</span>
          <button className="ghost" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages} title="Next page">▼</button>
        </div>
        <span className="spacer" />
        <div className="zoom">
          <button className="ghost" onClick={() => zoomBy(1 / 1.1)} disabled={scale <= MIN_SCALE} title="Zoom out">−</button>
          <button className="zoom-val" onClick={fitWidth} title="Fit to width">{pct}%</button>
          <button className="ghost" onClick={() => zoomBy(1.1)} disabled={scale >= MAX_SCALE} title="Zoom in">+</button>
        </div>
      </div>
      <div className="pdf-scroll" ref={scrollRef} onMouseUp={onMouseUp} onClick={onClick}>
        {note && <div className={noteIsReport ? 'pdf-note pdf-note-report' : 'pdf-note'}>{note}</div>}
        <div className="pdf-pages" ref={pagesRef} />
        {draft && (
          <div className="composer" style={{ left: draft.x, top: draft.y }} onMouseUp={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <div className="composer-quote">“{draft.quote.slice(0, 120)}{draft.quote.length > 120 ? '…' : ''}”</div>
            <textarea
              autoFocus
              placeholder="Comment or editing instruction… (e.g. tighten this paragraph)"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submitDraft(); if (e.key === 'Escape') setDraft(null); }}
            />
            <div className="composer-actions">
              <button className="ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button className="on" disabled={!draftText.trim()} onClick={() => void submitDraft()}>💬 Add comment</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
