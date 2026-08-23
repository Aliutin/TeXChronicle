import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffView } from '../ui/src/components/DiffView.js';

const render = (diff: string) => renderToStaticMarkup(createElement(DiffView, { diff }));

test('a one-word prose edit is one row with only the changed words marked', () => {
  const html = render([
    'diff --git a/Abstract.tex b/Abstract.tex',
    '@@ -1 +1 @@',
    '-The quick brown fox crosses the field.',
    '+The quick blue fox crosses the field.',
  ].join('\n'));

  assert.match(html, /class="dv-row dv-mod"/);
  assert.match(html, /class="dv-word-del">brown<\/span>/);
  assert.match(html, /class="dv-word-add">blue<\/span>/);
  assert.equal((html.match(/The quick /g) ?? []).length, 1, 'unchanged prose should not be duplicated');
  assert.doesNotMatch(html, /class="dv-row dv-del"/);
  assert.doesNotMatch(html, /class="dv-row dv-add"/);
});

test('unrelated long replacement lines remain an honest deletion and addition', () => {
  const oldLine = `-${'alpha '.repeat(40)}`;
  const newLine = `+${'omega '.repeat(40)}`;
  const html = render([
    'diff --git a/section.tex b/section.tex',
    '@@ -1 +1 @@',
    oldLine,
    newLine,
  ].join('\n'));

  assert.match(html, /class="dv-row dv-del"/);
  assert.match(html, /class="dv-row dv-add"/);
  assert.doesNotMatch(html, /class="dv-row dv-mod"/);
});
