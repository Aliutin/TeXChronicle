import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageRenderWindow, type PageBox } from '../ui/src/pageWindow.js';

// A4 at 1.5× is about 1123px tall, laid out with the 14px gap and 14px padding
// the pages pane uses. Only the numbers the decision looks at.
const PAGE = 1123;
const GAP = 14;
const PANE = 1000; // a typical PDF pane on a laptop

const doc = (count: number): PageBox[] =>
  Array.from({ length: count }, (_, index) => ({ top: GAP + index * (PAGE + GAP), height: PAGE }));

/** The page whose middle is on screen at this scroll offset. */
const pageAt = (scrollTop: number) => Math.floor((scrollTop + PANE / 2 - GAP) / (PAGE + GAP));

test('a long document paints a handful of pages, not all of them', () => {
  // The bug this exists to stop: 300 full-resolution canvases held at once, at
  // roughly 8MB each. What matters is not the exact count but that it does not
  // grow with the document.
  const pages = doc(300);
  const top = pageRenderWindow(pages, 0, PANE);
  assert.equal(top.first, 0);
  assert.ok(top.last < 10, `kept ${top.last + 1} pages at the top of a 300-page document`);

  const deep = pageRenderWindow(pages, 150 * (PAGE + GAP), PANE);
  assert.ok(deep.last - deep.first < 10, `kept ${deep.last - deep.first + 1} pages in the middle`);
  // And it moved with the reader rather than starting from page 1 every time.
  assert.ok(deep.first > 100);
});

test('the window always contains the page being read', () => {
  const pages = doc(60);
  for (const scrollTop of [0, 500, PAGE, 12_345, 40 * (PAGE + GAP) + 17]) {
    const window = pageRenderWindow(pages, scrollTop, PANE);
    const visible = pageAt(scrollTop);
    assert.ok(
      visible >= window.first && visible <= window.last,
      `page ${visible} is on screen at scrollTop ${scrollTop} but the window is ${window.first}..${window.last}`,
    );
  }
});

test('two viewports of slack sit either side of what is on screen', () => {
  // Enough that ordinary scrolling and a Page Down never land on a page that
  // has not started drawing yet.
  const pages = doc(60);
  const scrollTop = 20 * (PAGE + GAP);
  const window = pageRenderWindow(pages, scrollTop, PANE, 2);
  const first = pages[window.first];
  const last = pages[window.last];
  assert.ok(first.top + first.height >= scrollTop - 2 * PANE);
  assert.ok(last.top <= scrollTop + PANE + 2 * PANE);
  // The pages just outside are genuinely outside — the range is not the
  // whole document dressed up.
  if (window.first > 0) {
    const before = pages[window.first - 1];
    assert.ok(before.top + before.height < scrollTop - 2 * PANE);
  }
  const tight = pageRenderWindow(pages, scrollTop, PANE, 0);
  assert.ok(tight.first >= window.first && tight.last <= window.last, 'less slack cannot widen the window');
});

test('scrolling one page at a time moves the window one page at a time', () => {
  const pages = doc(120);
  let previous = pageRenderWindow(pages, 0, PANE);
  for (let page = 1; page < 30; page++) {
    const window = pageRenderWindow(pages, page * (PAGE + GAP), PANE);
    assert.ok(window.first >= previous.first, 'the window never runs backwards while scrolling forwards');
    assert.ok(window.first - previous.first <= 2, 'the window never jumps past pages the reader passed through');
    previous = window;
  }
});

test('degenerate inputs never blank the whole pane', () => {
  // Empty is the only answer that means "nothing to paint".
  const empty = pageRenderWindow([], 0, PANE);
  assert.ok(empty.last < empty.first);

  // A pane that has not been laid out yet reports no height. Keeping the page
  // under the scroll offset is right; keeping none of them is a blank viewer.
  const unlaid = pageRenderWindow(doc(10), 3 * (PAGE + GAP) + 100, 0);
  assert.equal(unlaid.first, 3);
  assert.equal(unlaid.last, 3);

  // Scrolled far past the end, which happens for a frame after a reload shrinks
  // the document. The nearest page is kept rather than nothing at all.
  const past = pageRenderWindow(doc(4), 900_000, PANE);
  assert.equal(past.first, 3);
  assert.equal(past.last, 3);

  // A single page is always its own window.
  assert.deepEqual(pageRenderWindow(doc(1), 0, PANE), { first: 0, last: 0 });
});

test('pages of different heights are measured, not counted', () => {
  // A paper with a landscape plate or an A3 fold-out: the window has to follow
  // the real geometry, which is why it takes boxes rather than a page count.
  const pages: PageBox[] = [
    { top: 0, height: 100 },
    { top: 100, height: 20_000 }, // one enormous page
    { top: 20_100, height: 100 },
    { top: 20_200, height: 100 },
  ];
  const window = pageRenderWindow(pages, 0, 500, 2);
  assert.equal(window.first, 0);
  assert.equal(window.last, 1, 'the giant page is in view; the ones beyond it are not');
});
