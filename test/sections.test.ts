import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSectionGraph, latexIncludedFiles, parseLatexSections } from '../src/latex/sections.js';

test('parses a nested LaTeX section tree without treating comments or verbatim as headings', () => {
  const source = String.raw`\documentclass{article}
\newcommand{\fake}{\section{Preamble fake}}
\begin{document}
% \section{Comment fake}
\section{Introduction}\label{sec:intro}
Opening text.
\subsection{Motivation}
Why this matters.
\begin{verbatim}
\section{Literal fake}
\end{verbatim}
\section{Results}
Evidence.
\end{document}`;

  const parsed = parseLatexSections(source, 'paper.tex');
  assert.deepEqual(parsed.map((s) => s.title), ['Introduction', 'Motivation', 'Results']);
  assert.equal(parsed[0].label, 'sec:intro');
  assert.equal(parsed[1].parentIndex, 0);
  assert.equal(parsed[2].parentIndex, undefined);
  assert.match(parsed[0].source, /Motivation/,
    'the complete section source includes its subsection for restoration');
  assert.doesNotMatch(parsed[0].ownSource, /Why this matters/,
    'the semantic text excludes child bodies so a moved child is a structural change');
});

test('matches a renamed section and a moved subsection into stable histories', () => {
  const first = String.raw`\begin{document}
\section{Introduction}
The paper studies information diffusion in messaging groups.
\subsection{Motivation}
This question matters for collective action.
\section{Results}
We report the principal estimates.
\subsection{Robustness}
Alternative specifications give similar estimates.
\end{document}`;
  const second = String.raw`\begin{document}
\section{Background and Motivation}
The paper studies information diffusion in messaging groups.
\subsection{Motivation}
This question matters for collective action.
\section{Results}
We report the principal estimates.
\section{Additional analyses}
\subsection{Robustness}
Alternative specifications give similar estimates.
\end{document}`;

  const graph = buildSectionGraph([
    { sha: 'a'.repeat(40), time: '2026-08-23T10:00:00Z', files: [{ path: 'main.tex', source: first }] },
    { sha: 'b'.repeat(40), time: '2026-08-23T10:05:00Z', files: [{ path: 'main.tex', source: second }] },
  ]);

  const introduction = graph.sections.find((s) => s.versions[0].title === 'Introduction');
  assert.ok(introduction);
  assert.equal(introduction.title, 'Background and Motivation');
  assert.equal(introduction.versions.length, 2);
  assert.ok(introduction.versions[1].changes.includes('renamed'));

  const robustness = graph.sections.find((s) => s.title === 'Robustness');
  assert.ok(robustness);
  assert.equal(robustness.versions.length, 2);
  assert.ok(robustness.versions[1].changes.includes('moved'));
  assert.equal(robustness.versions[0].sectionId, robustness.versions[1].sectionId,
    'moving a subsection must not create a new semantic identity');
});

test('does not add a section version when only an unrelated section changed', () => {
  const first = String.raw`\begin{document}
\section{Introduction}
Stable introduction.
\section{Results}
First result.
\end{document}`;
  const second = first.replace('First result.', 'Revised result.');
  const graph = buildSectionGraph([
    { sha: '1'.repeat(40), time: '2026-08-23T10:00:00Z', files: [{ path: 'main.tex', source: first }] },
    { sha: '2'.repeat(40), time: '2026-08-23T10:05:00Z', files: [{ path: 'main.tex', source: second }] },
  ]);

  assert.equal(graph.sections.find((s) => s.title === 'Introduction')?.versions.length, 1);
  assert.equal(graph.sections.find((s) => s.title === 'Results')?.versions.length, 2);
});

test('tracks the abstract as a first-class semantic part', () => {
  const first = String.raw`\begin{document}
\begin{abstract}
Initial summary.
\end{abstract}
\section{Introduction}
Stable introduction.
\end{document}`;
  const second = first.replace('Initial summary.', 'Revised summary.');
  const graph = buildSectionGraph([
    { sha: '3'.repeat(40), time: '2026-08-23T10:00:00Z', files: [{ path: 'main.tex', source: first }] },
    { sha: '4'.repeat(40), time: '2026-08-23T10:05:00Z', files: [{ path: 'main.tex', source: second }] },
  ]);

  const abstract = graph.sections.find((section) => section.title === 'Abstract');
  assert.ok(abstract);
  assert.equal(abstract.command, 'abstract');
  assert.equal(abstract.versions.length, 2);
  assert.ok(abstract.versions[1].changes.includes('edited'));
  assert.equal(graph.sections.find((section) => section.title === 'Introduction')?.versions.length, 1);
});

test('finds real input files without following commented or literal examples', () => {
  const source = String.raw`% \input{ignored}
\input{sections/intro}
\begin{verbatim}
\include{also-ignored}
\end{verbatim}
\include { results }`;
  assert.deepEqual(latexIncludedFiles(source), ['sections/intro', 'results']);
});
