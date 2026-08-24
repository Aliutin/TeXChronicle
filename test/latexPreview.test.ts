import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentEditableParagraphDraft,
  expandLatexIncludes,
  maskLatexComments,
  parseLatexPreview,
  previewPlainText,
  previewTextChange,
  resolveLatexInclude,
  type InlineNode,
} from '../ui/src/latexPreview.js';

function textLeaves(nodes: InlineNode[]): Array<Extract<InlineNode, { type: 'text' }>> {
  return nodes.flatMap((node): Array<Extract<InlineNode, { type: 'text' }>> => {
    if (node.type === 'text') return [node];
    if ('children' in node) return textLeaves(node.children);
    return [];
  });
}

test('live preview builds a readable academic document model', () => {
  const source = String.raw`\documentclass{article}
\begin{document}
\title{A \textbf{Rich} Paper}
\author{Ada Lovelace \\ Grace Hopper}
\date{2026}
\maketitle

\section{Introduction}\label{sec:intro}
Visible \emph{prose}, \citep{one,two}, Section~\ref{sec:intro}, and $x^2$.\footnote{A useful note.}

\begin{enumerate}
  \item First result
  \item Second \textbf{result}
\end{enumerate}

\begin{equation}\label{eq:main}
y = \beta x
\end{equation}

\begin{figure}
\includegraphics[width=\linewidth]{result.png}
\caption{Main result.}\label{fig:main}
\end{figure}

\begin{table}
\caption{Summary.}\label{tab:summary}
\begin{tabular}{ll}
Name & Value \\
\midrule
A & 1 \\
\end{tabular}
\end{table}
\end{document}`;

  const document = parseLatexPreview(source);
  const title = document.blocks.find((block) => block.type === 'title');
  assert.ok(title && title.type === 'title');
  assert.equal(previewPlainText(title.title), 'A Rich Paper');
  assert.match(previewPlainText(title.author), /Ada Lovelace Grace Hopper/);

  const heading = document.blocks.find((block) => block.type === 'heading' && previewPlainText(block.content) === 'Introduction');
  assert.ok(heading && heading.type === 'heading');
  assert.equal(heading.number, '1');
  assert.deepEqual(document.references['sec:intro'], { number: '1', kind: 'section' });
  assert.deepEqual(document.references['eq:main'], { number: '1', kind: 'equation' });
  assert.deepEqual(document.references['fig:main'], { number: '1', kind: 'figure' });
  assert.deepEqual(document.references['tab:summary'], { number: '1', kind: 'table' });

  const list = document.blocks.find((block) => block.type === 'list');
  assert.ok(list && list.type === 'list');
  assert.equal(list.items.length, 2);
  assert.equal(previewPlainText(list.items[1].content), 'Second result');

  const figure = document.blocks.find((block) => block.type === 'figure');
  assert.ok(figure && figure.type === 'figure');
  assert.deepEqual(figure.assets, ['result.png']);

  const table = document.blocks.find((block) => block.type === 'table');
  assert.ok(table && table.type === 'table');
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].header, true);
  assert.equal(previewPlainText(table.rows[0].cells[0].content), 'Name');
  assert.equal(document.footnotes.length, 1);
  assert.equal(previewPlainText(document.footnotes[0].content), 'A useful note.');
});

test('comments disappear without changing source-line locations', () => {
  const source = String.raw`\begin{document}
100\% visible % hidden command \section{Wrong}

\section{Right}
Body.
\end{document}`;
  const masked = maskLatexComments(source);
  assert.match(masked, /100\\% visible/);
  assert.doesNotMatch(masked, /Wrong/);

  const document = parseLatexPreview(source);
  const heading = document.blocks.find((block) => block.type === 'heading');
  assert.ok(heading && heading.type === 'heading');
  assert.equal(previewPlainText(heading.content), 'Right');
  assert.equal(heading.line, 4);
});

test('unknown and incomplete macros degrade locally instead of blanking the preview', () => {
  const source = String.raw`\section{Still visible}
A \projectMacro{preserved phrase} and \unfinished{partial`;
  const document = parseLatexPreview(source);
  const text = document.blocks.map((block) => 'content' in block && Array.isArray(block.content) ? previewPlainText(block.content) : '').join(' ');
  assert.match(text, /preserved phrase/);
  assert.match(text, /partial/);
  assert.deepEqual(document.approximated, ['\\projectMacro', '\\unfinished']);
});

test('included section files are expanded with exact file and line locations', async () => {
  const root = String.raw`\documentclass{article}
\input{preamble-map}
\begin{document}
\section{Main}
\input{sections/intro}
\end{document}`;
  const files: Record<string, string> = {
    'sections/intro.tex': String.raw`\section{Included}
Included prose.
\input{more}`,
    'sections/more.tex': String.raw`\subsection{Nested}
Nested prose.`,
  };
  const requested: string[] = [];
  const controller = new AbortController();
  const expanded = await expandLatexIncludes('main.tex', root, async (path) => {
    requested.push(path);
    return files[path] ?? null;
  }, controller.signal);

  assert.deepEqual(requested, ['sections/intro.tex', 'sections/more.tex']);
  assert.doesNotMatch(expanded.text, /\\input\{sections\/intro\}/);
  const includedLine = expanded.text.split('\n').findIndex((line) => line.includes('Included prose.'));
  const nestedLine = expanded.text.split('\n').findIndex((line) => line.includes('Nested prose.'));
  assert.deepEqual(expanded.locations[includedLine], { file: 'sections/intro.tex', line: 2 });
  assert.deepEqual(expanded.locations[nestedLine], { file: 'sections/more.tex', line: 2 });
});

test('include resolution stays within the project and adds the tex extension', () => {
  assert.equal(resolveLatexInclude('chapters/main.tex', './intro'), 'chapters/intro.tex');
  assert.equal(resolveLatexInclude('chapters/main.tex', '../appendix/a.tex'), 'appendix/a.tex');
  assert.equal(resolveLatexInclude('main.tex', '../../outside'), null);
  assert.equal(resolveLatexInclude('main.tex', '../tables/generated', true), '../tables/generated.tex');
  assert.equal(resolveLatexInclude('main.tex', 'https://example.com/a.tex'), null);
});

test('wrapped generated table includes become a simplified read-only table', async () => {
  const root = String.raw`\begin{document}
\begin{table}
\caption{Generated results.}
\resizebox{\textwidth}{!}{\input{../tables/generated}}
\end{table}
\begin{verbatim}
\iffalse
\input{../tables/not-a-dependency}
\end{verbatim}
Inline \verb|\input{../tables/also-not-a-dependency}|.
\iffalse
\begin{table}
\caption{Inactive table.}
\input{../tables/inactive}
\end{table}
\fi
\iffalse Hidden branch.\else Active conditional prose.\fi
\end{document}`;
  const child = String.raw`\begin{tabular}{lc}
\toprule
Term & Estimate \\
\cmidrule(lr){1-2}
Effect & $-0.25$ \\
\bottomrule
\end{tabular}`;
  const requested: string[] = [];
  const expanded = await expandLatexIncludes('main.tex', root, async (path) => {
    requested.push(path);
    return path === '../tables/generated.tex'
      ? { path, content: child, editable: false }
      : null;
  }, new AbortController().signal, { allowParent: true });

  assert.deepEqual(requested, ['../tables/generated.tex']);
  const effectLine = expanded.text.split('\n').findIndex((line) => line.includes('Effect'));
  assert.deepEqual(expanded.locations[effectLine], { file: '../tables/generated.tex', line: 5, editable: false });

  const document = parseLatexPreview(expanded.text);
  const tables = document.blocks.filter((block) => block.type === 'table');
  assert.equal(tables.length, 1, 'an inactive conditional table leaked into Live');
  const table = tables[0];
  assert.ok(table && table.type === 'table');
  assert.equal(table.rows.length, 2);
  assert.equal(previewPlainText(table.rows[0].cells[0].content), 'Term');
  assert.equal(previewPlainText(table.rows[1].cells[0].content), 'Effect');
  assert.match(document.blocks.map((block) => 'content' in block && Array.isArray(block.content) ? previewPlainText(block.content) : '').join(' '), /Active conditional prose/);
});

test('visual prose edits replace only the changed source slice', () => {
  const source = String.raw`\begin{document}
Visible --- text before \emph{important words}, 100\% sure, and \citep{source-key}.
\end{document}`;
  const document = parseLatexPreview(source);
  const paragraph = document.blocks.find((block) => block.type === 'paragraph');
  assert.ok(paragraph && paragraph.type === 'paragraph');

  const leaf = textLeaves(paragraph.content).find((node) => node.text.includes('Visible'));
  assert.ok(leaf?.source);
  const after = leaf.text.replace('text', 'revised text & evidence');
  const change = previewTextChange(leaf.source, leaf.text, after);
  assert.ok(change);
  assert.equal(change.expected, 'text');
  assert.equal(change.insert, 'revised text \\& evidence');

  const edited = source.slice(0, change.from) + change.insert + source.slice(change.to);
  assert.equal(edited, String.raw`\begin{document}
Visible --- revised text \& evidence before \emph{important words}, 100\% sure, and \citep{source-key}.
\end{document}`);
});

test('editing formatted text preserves its wrapper and every protected neighbor', () => {
  const source = String.raw`Plain \textbf{old result} with $x^2$, \ref{sec:a}, and \custom{kept text}.`;
  const document = parseLatexPreview(source);
  const paragraph = document.blocks.find((block) => block.type === 'paragraph');
  assert.ok(paragraph && paragraph.type === 'paragraph');
  const oldResult = textLeaves(paragraph.content).find((node) => node.text === 'old result');
  assert.ok(oldResult?.source);

  const change = previewTextChange(oldResult.source, oldResult.text, 'new 50% result');
  assert.ok(change);
  const edited = source.slice(0, change.from) + change.insert + source.slice(change.to);
  assert.equal(edited, String.raw`Plain \textbf{new 50\% result} with $x^2$, \ref{sec:a}, and \custom{kept text}.`);
});

test('escaped characters stay in one editable leaf across consecutive visual edits', () => {
  const source = 'alpha beta';
  const first = parseLatexPreview(source).blocks[0];
  assert.ok(first?.type === 'paragraph');
  const original = textLeaves(first.content)[0];
  assert.ok(original?.source);
  const addSpecial = previewTextChange(original.source, original.text, 'alpha_beta');
  assert.ok(addSpecial);
  const withSpecial = source.slice(0, addSpecial.from) + addSpecial.insert + source.slice(addSpecial.to);
  assert.equal(withSpecial, String.raw`alpha\_beta`);

  const reparsed = parseLatexPreview(withSpecial).blocks[0];
  assert.ok(reparsed?.type === 'paragraph');
  const merged = textLeaves(reparsed.content);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'alpha_beta');
  assert.equal(merged[0].source?.raw, String.raw`alpha\_beta`);

  const append = previewTextChange(merged[0].source!, merged[0].text, 'alpha_beta result');
  assert.ok(append);
  assert.equal(withSpecial.slice(0, append.from) + append.insert + withSpecial.slice(append.to), String.raw`alpha\_beta result`);
});

test('browser line breaks become LaTeX paragraph breaks on structural edits', () => {
  const browserDraft = 'First paragraph\nSecond paragraph\n';
  const latexDraft = contentEditableParagraphDraft(browserDraft);
  assert.equal(latexDraft, 'First paragraph\n\nSecond paragraph');

  const source = 'First paragraph';
  const paragraph = parseLatexPreview(source).blocks[0];
  assert.ok(paragraph?.type === 'paragraph');
  const text = textLeaves(paragraph.content)[0];
  assert.ok(text?.source);
  const change = previewTextChange(text.source, text.text, latexDraft);
  assert.ok(change);
  const edited = source.slice(0, change.from) + change.insert + source.slice(change.to);
  assert.equal(edited, latexDraft);
  assert.equal(parseLatexPreview(edited).blocks.filter((block) => block.type === 'paragraph').length, 2);
});
