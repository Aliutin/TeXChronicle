// Center panel: renders /latest.pdf with pdf.js (canvas + selectable text
// layer), re-renders on WS reload, and hosts the LiquidText-style interaction:
// select text on a page → floating "Comment" composer → anchored highlight.
// A control strip provides Overleaf-style zoom + page navigation; the render
// scale is state, and highlights are stored at scale 1 and projected by it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { pdfjs } from '../pdfRuntime';
import { createComment, inverseSyncTeX, type Comment, type SyncTeXSourceLocation } from '../api';
import { normalize, phrase } from '../sync';
import { groupLines, columnsFromTextItems } from '../lines';

const MIN_SCALE = 0.4;
const MAX_SCALE = 3;

interface Draft { page: number; quote: string; rects: { x: number; y: number; w: number; h: number }[]; x: number; y: number }
interface SyncTarget { text: string; nonce: number }

export function PdfView({
  reloadTick, pdfUrl = '/latest.pdf', historicalLabel, onReturnLatest,
  comments, onPages, onSelectComment, onSyncToSource, syncTarget, missingMessage,
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

  // ── Render PDF pages (canvas + text layer) ──────────────────────────────
  useEffect(() => {
    let cancelled = false;
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
      if (!res.ok) {
        setNoteIsReport(false);
        setNote(missingMessage ?? 'No PDF yet — wait for the initial compile or click Recompile.');
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
      for (let i = 1; i <= doc.numPages; i++) {
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
        canvas.width = vp.width;
        canvas.height = vp.height;
        wrap.appendChild(canvas);
        const textDiv = document.createElement('div');
        textDiv.className = 'textLayer';
        wrap.appendChild(textDiv);
        const hlDiv = document.createElement('div');
        hlDiv.className = 'hl-layer';
        wrap.appendChild(hlDiv);
        next.appendChild(wrap);
        // pdf.js v5 made `canvas` the required parameter and demoted
        // `canvasContext` to a back-compat alias, so pass the element.
        step = `page ${i}/${doc.numPages}: canvas render`;
        await pg.render({ canvas, viewport: vp }).promise;
        step = `page ${i}/${doc.numPages}: text layer`;
        const textLayer = new pdfjs.TextLayer({ textContentSource: pg.streamTextContent(), container: textDiv, viewport: vp });
        await textLayer.render();
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
          console.warn(`[magictex] column detection skipped — ${step}`, e);
        }
        if (!hadPages) {
          // Moving the wrapper out of the fragment makes the page visible;
          // later pages continue rendering without covering page 1 with a
          // blocking progress message.
          container.appendChild(wrap);
          if (i === 1) {
            setNote('');
            setRenderTick((t) => t + 1);
          }
        }
      }
      if (cancelled) return;
      if (hadPages) container.replaceChildren(next);
      setNote('');
      setRenderTick((t) => t + 1);
      scroller.scrollTop = ratio * scroller.scrollHeight;
    })().catch((e) => {
      // A superseded run must not speak. Every other exit in this effect is gated
      // on `cancelled`; the catch was not, so a run abandoned by a zoom click or
      // a reload could reject AFTER a newer run had rendered fine and paint a
      // full failure report over it — styled, deliberately, to be screenshotted
      // into a bug report. The reporting work manufacturing false reports.
      if (cancelled) { console.warn('[MagicTeX] superseded render failed during: ' + step, e); return; }
      // The console gets the error object itself, so DevTools can offer a real
      // clickable stack; the pane gets a report someone can screenshot. A
      // screenshot is what actually reaches a maintainer, so it has to carry
      // enough on its own — which step, which browser, which pdf.js.
      console.error('[MagicTeX] PDF render failed during: ' + step, e);
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
      // With workerSrc each loading task owns its worker. Release it when a PDF
      // asset is closed or zoom starts a replacement render; otherwise checking
      // several figures leaves one worker and document transport alive per file.
      void loadingTask?.destroy().catch(() => {});
    };
  }, [reloadTick, scale, onPages, pdfUrl, missingMessage]);

  // ── Track which page is in view (for the page indicator) ────────────────
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
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => { scroller.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [renderTick]);

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
        if (boxes) for (const b of boxes) box(layer, c, statusCls, b.l, b.t, b.w, b.h);
        else for (const r of c.rects) box(layer, c, statusCls, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
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
  }, [comments, renderTick, scale, onSelectComment]);

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
