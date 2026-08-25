// Which pages of an open PDF are worth holding pixels for.
//
// Every page used to keep a full-resolution canvas in the DOM for as long as the
// document was open. At 1.5× a letter page is roughly 1275×1650 device pixels,
// four bytes each: about 8 MB per page, so a 300-page thesis asked the browser
// for well over a gigabyte and the tab died somewhere before it got there. The
// wrapper divs still carry each page's exact size — scroll position, page
// navigation and highlight geometry all depend on that and must not move — but
// the canvas inside a wrapper far from the viewport is released and repainted
// when the reader comes back to it.
//
// The decision is here, rather than in the component, so it can be tested with
// plain numbers instead of a browser.

export interface PageBox {
  /** Distance from the top of the scrolling content to the top of the page. */
  top: number;
  height: number;
}

/** An inclusive range of page indices. `last < first` means "no pages". */
export interface PageRange { first: number; last: number }

/**
 * The pages that should hold a rendered canvas.
 *
 * `slack` is measured in viewports: one viewport of pages above and below the
 * visible band, so ordinary scrolling and a Page Down never land on a blank
 * page. Pages are stacked vertically, so the answer is always contiguous.
 */
export function pageRenderWindow(
  pages: PageBox[],
  scrollTop: number,
  viewportHeight: number,
  slack = 2,
): PageRange {
  if (!pages.length) return { first: 0, last: -1 };
  // A pane that has not been laid out yet reports zero height. Falling through
  // with it would keep exactly the page under scrollTop, which is the right
  // answer for a degenerate case and never zero pages.
  const height = Math.max(0, viewportHeight);
  const margin = Math.max(0, slack) * height;
  const top = scrollTop - margin;
  const bottom = scrollTop + height + margin;

  let first = -1;
  let last = -1;
  for (let index = 0; index < pages.length; index++) {
    const pageTop = pages[index].top;
    const pageBottom = pageTop + Math.max(0, pages[index].height);
    if (pageBottom < top || pageTop > bottom) continue;
    if (first < 0) first = index;
    last = index;
  }
  if (first >= 0) return { first, last };

  // Nothing overlaps: the scroll position is past the end of the document, or
  // the sizes are one frame stale. Keep the nearest page alive rather than
  // blanking the whole pane — an empty answer here reads as a bug to whoever is
  // looking at it.
  const centre = scrollTop + height / 2;
  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < pages.length; index++) {
    const pageTop = pages[index].top;
    const pageBottom = pageTop + Math.max(0, pages[index].height);
    const distance = centre < pageTop ? pageTop - centre : centre > pageBottom ? centre - pageBottom : 0;
    if (distance < best) { best = distance; nearest = index; }
  }
  return { first: nearest, last: nearest };
}
