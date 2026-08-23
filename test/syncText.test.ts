import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDocumentTitle, findSourceLine, normalize, stripLatex } from '../ui/src/sync.js';

test('normalization preserves non-ASCII words and folds visible accents', () => {
  assert.equal(normalize('Castañeda — Ўзбекистон'), 'castaneda узбекистон');
});

test('TeX accent commands match their rendered PDF spelling', () => {
  const source = String.raw`\author{Anton Liutin and Paul Casta\~{n}eda Dower}`;
  assert.equal(normalize(stripLatex(source)), 'anton liutin and paul castaneda dower');
});

test('a SyncTeX hint disambiguates repeated prose by proximity', () => {
  const source = ['Repeated phrase in the first section.', '', '', 'Repeated phrase in the appendix.'].join('\n');
  assert.equal(findSourceLine(source, 'Repeated phrase in the appendix.', 4), 3);
});

test('visible prose refines a maketitle-wide SyncTeX result', () => {
  const source = [
    String.raw`\title{A Paper}`,
    String.raw`\author{Anton Liutin and Paul Casta\~{n}eda Dower}`,
    String.raw`\date{August 2026}`,
    String.raw`\maketitle`,
  ].join('\n');
  assert.equal(findSourceLine(source, 'Anton Liutin and Paul Castañeda Dower', 4), 1);
});

test('fallback matching spans normally wrapped source lines', () => {
  const source = 'Policy feedback crosses\nsource line boundaries in ordinary editors.';
  assert.equal(findSourceLine(source, 'Policy feedback crosses source line boundaries'), 0);
});

test('a nested legacy title does not leak thanks, authors, or date into the header', () => {
  const source = String.raw`\documentclass{article}
\title{{\Large Double Vision in Policy Implementation}
  \thanks{{\footnotesize Preliminary draft.}}
  \author{First Author \\ University}
  \date{August 2026}}
\begin{document}`;
  assert.equal(extractDocumentTitle(source), 'Double Vision in Policy Implementation');
});
