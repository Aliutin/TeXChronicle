import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentEditableParagraphDraft,
  differsOnlyByMasking,
  expandLatexIncludes,
  maskLatexComments,
  parseLatexPreview,
  previewPlainText,
  previewTextChange,
  resolveLatexInclude,
  type InlineNode,
  type PreviewBlock,
} from '../ui/src/latexPreview.js';

function textLeaves(nodes: InlineNode[]): Array<Extract<InlineNode, { type: 'text' }>> {
  return nodes.flatMap((node): Array<Extract<InlineNode, { type: 'text' }>> => {
    if (node.type === 'text') return [node];
    if ('children' in node) return textLeaves(node.children);
    return [];
  });
}

function nestedBlocks(blocks: PreviewBlock[]): PreviewBlock[] {
  return blocks.flatMap((block): PreviewBlock[] => {
    if (block.type === 'frame' || block.type === 'callout') return [block, ...nestedBlocks(block.blocks)];
    if (block.type === 'columns') return [block, ...block.columns.flatMap(nestedBlocks)];
    return [block];
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

test('Beamer live preview keeps editable frames, columns, overlays, callouts, and slide artwork', () => {
  const source = String.raw`\documentclass[aspectratio=169]{beamer}
\title{A Live Deck}
\author{Ada Presenter}
\begin{document}
\begin{frame}[plain]
\titlepage
\end{frame}

\section{Main idea}
\begin{frame}<1->[fragile]{A \alert{Live} Frame}{Editable subtitle}
Original slide prose.

\pause
\begin{columns}[T,onlytextwidth]
  \begin{column}{.48\textwidth}
    \begin{alertblock}{Important result}
      Callout prose stays editable.
    \end{alertblock}
    \begin{itemize}[<+->]
      \item<2-> First revealed point
      \item<3-> Second revealed point
    \end{itemize}
  \end{column}
  \begin{column}{.48\textwidth}
    \centering
    \includegraphics[width=\linewidth]{result-chart.pdf}
  \end{column}
\end{columns}
\end{frame}
\end{document}`;

  const document = parseLatexPreview(source);
  assert.equal(document.kind, 'presentation');
  assert.equal(document.aspectRatio, '16:9');
  const frames = document.blocks.filter((block) => block.type === 'frame');
  assert.equal(frames.length, 2);

  const titleFrame = frames[0];
  assert.ok(titleFrame?.type === 'frame');
  const title = titleFrame.blocks.find((block) => block.type === 'title');
  assert.ok(title?.type === 'title');
  assert.equal(previewPlainText(title.title), 'A Live Deck');

  const contentFrame = frames[1];
  assert.ok(contentFrame?.type === 'frame');
  assert.equal(previewPlainText(contentFrame.title), 'A Live Frame');
  assert.equal(previewPlainText(contentFrame.subtitle), 'Editable subtitle');
  assert.equal(contentFrame.overlays, true);

  const all = nestedBlocks(contentFrame.blocks);
  const columns = all.find((block) => block.type === 'columns');
  assert.ok(columns?.type === 'columns');
  assert.equal(columns.columns.length, 2);
  const callout = all.find((block) => block.type === 'callout');
  assert.ok(callout?.type === 'callout');
  assert.equal(previewPlainText(callout.title), 'Important result');
  assert.equal(callout.tone, 'accent');
  const list = all.find((block) => block.type === 'list');
  assert.ok(list?.type === 'list');
  assert.deepEqual(list.items.map((item) => previewPlainText(item.content)), ['First revealed point', 'Second revealed point']);
  const image = all.find((block) => block.type === 'image');
  assert.ok(image?.type === 'image');
  assert.deepEqual(image.assets, ['result-chart.pdf']);

  const paragraph = all.find((block) => block.type === 'paragraph' && previewPlainText(block.content).includes('Original slide prose'));
  assert.ok(paragraph?.type === 'paragraph');
  const editable = textLeaves(paragraph.content).find((leaf) => leaf.text.includes('Original slide prose'));
  assert.ok(editable?.source);
  assert.equal(source.slice(editable.source.from, editable.source.to), 'Original slide prose.');
  assert.doesNotMatch(all.map((block) => block.type === 'paragraph' ? previewPlainText(block.content) : '').join(' '), /<\d/);
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

// ── Fixes for Live on ordinary papers ──────────────────────────────────────
// Every case below is a real construct from a real paper that Live either
// dropped, mangled, or died on.

/** Everything Live would actually show, flattened. */
function visibleText(source: string): string {
  const document = parseLatexPreview(source);
  const fromBlock = (block: PreviewBlock): string[] => {
    switch (block.type) {
      case 'title': return [previewPlainText(block.title), previewPlainText(block.author)];
      case 'heading': case 'paragraph': case 'quote': return [previewPlainText(block.content)];
      case 'list': return block.items.flatMap((item) => [previewPlainText(item.label ?? []), previewPlainText(item.content)]);
      case 'figure': return [previewPlainText(block.caption)];
      case 'table': return [previewPlainText(block.caption), ...block.rows.flatMap((row) => row.cells.map((cell) => previewPlainText(cell.content)))];
      case 'frame': return [previewPlainText(block.title), ...block.blocks.flatMap(fromBlock)];
      case 'columns': return block.columns.flatMap((column) => column.flatMap(fromBlock));
      case 'callout': return [previewPlainText(block.title), ...block.blocks.flatMap(fromBlock)];
      case 'code': return [block.content];
      default: return [];
    }
  };
  return document.blocks.flatMap(fromBlock).join(' ');
}

const article = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}`;

test('a very long paragraph after an escaped character does not overflow the stack', () => {
  // `push(...boundaries)` spread 125k arguments and took the whole Live pane
  // down with a RangeError that the Retry button could only reproduce.
  assert.doesNotThrow(() => parseLatexPreview(article(`a\\% ${'w'.repeat(200000)}`)));
  assert.doesNotThrow(() => parseLatexPreview(article(`\\'{e} ${'word '.repeat(40000)}`)));
  assert.equal(parseLatexPreview(article(`A \\& B ${'word '.repeat(1000)}`)).wordCount, 1003);
});

test('a bracket after a layout macro is prose, not an optional argument', () => {
  assert.match(visibleText(article('\\noindent [1] Smith et al. A paper. 2020.')), /\[1\] Smith et al\./);
  assert.match(visibleText(article('{\\small [0,1) interval} tail text.')), /\[0,1\) interval tail text\./);
  assert.match(visibleText(article('\\centering [a] bracketed lead-in.')), /\[a\] bracketed lead-in\./);
  // …but a genuine length after `\\` is layout and must not be read out loud.
  const broken = visibleText(article('Text\\\\[2pt] next line of the same paragraph.'));
  assert.doesNotMatch(broken, /2pt/);
  assert.match(broken, /Text next line of the same paragraph\./);
});

test('an unterminated argument never swallows the rest of the document', () => {
  // `readGroup` answers an unmatched delimiter with a group running to the end
  // of the source. Trusting it blanked every remaining paragraph.
  assert.match(visibleText(article('\\vspace{1em Prose that follows should still be visible.')), /Prose that follows should still be visible/);
  const list = visibleText(article('\\begin{itemize}\n\\item [0,1) is the range here.\n\\item Second item.\n\\end{itemize}'));
  assert.match(list, /\[0,1\) is the range here/);
  assert.match(list, /Second item/);
});

test('an unknown macro shows the argument that actually has content', () => {
  // Last argument first — \pill{blue}{Text} — but never at the cost of showing
  // nothing at all, which is what \SI{5}{\metre} rendered.
  assert.match(visibleText(article('Text \\SI{5}{\\metre} more.')), /Text 5 more\./);
  assert.match(visibleText(article('\\pill{blue}{Visible Text} tail.')), /Visible Text tail\./);
  assert.match(visibleText(article('Text \\gls{term} more.')), /Text term more\./);
});

test('a sentence sharing a line with an image survives', () => {
  const source = article('Prose before.\n\\includegraphics[width=2cm]{logo} is our logo and this sentence continues.\nProse after.');
  assert.match(visibleText(source), /is our logo and this sentence continues\./);
  // An image alone on its line is still a block of its own.
  const alone = parseLatexPreview(article('\\includegraphics[width=2cm]{logo}'));
  const image = alone.blocks.find((block) => block.type === 'image');
  assert.ok(image?.type === 'image');
  assert.deepEqual(image.assets, ['logo']);
});

test('a frame quoted inside verbatim does not turn a paper into a slide deck', () => {
  const source = article('Prose.\n\\begin{verbatim}\n\\begin{frame}{X}\n\\end{frame}\n\\end{verbatim}\nMore prose.');
  assert.equal(parseLatexPreview(source).kind, 'article');
  assert.equal(parseLatexPreview('\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}\nA.\n\\end{frame}\n\\end{document}').kind, 'presentation');
});

test('overlay masking stays out of ordinary papers', () => {
  // `<expr> ::= …` is BNF in a CS paper, and `\alert<x>` is prose about a macro.
  assert.match(visibleText(article('The condition \\alert<x> is prose.')), /<x>/);
  assert.match(visibleText(article('\\begin{itemize}\n\\item\n<not overlay> real prose here\n\\end{itemize}')), /<not overlay> real prose here/);
  // A deck still hides them.
  const deck = parseLatexPreview('\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}\n\\begin{itemize}\n\\item<2-> Revealed point\n\\end{itemize}\n\\end{frame}\n\\end{document}');
  assert.doesNotMatch(JSON.stringify(deck.blocks), /<2-/);
});

test('a figure with subfigures shows its own caption and numbers its panels', () => {
  const source = String.raw`\documentclass{article}
\begin{document}
\begin{figure}[t]
  \begin{subfigure}[b]{0.48\textwidth}
    \includegraphics[width=\linewidth]{a}
    \caption{Left panel shows A}\label{fig:a}
  \end{subfigure}
  \begin{subfigure}[b]{0.48\textwidth}
    \includegraphics[width=\linewidth]{b}
    \caption{Right panel shows B}\label{fig:b}
  \end{subfigure}
  \caption{THE MAIN CAPTION that readers see.}
  \label{fig:main}
\end{figure}
\end{document}`;
  const document = parseLatexPreview(source);
  const figure = document.blocks.find((block) => block.type === 'figure');
  assert.ok(figure?.type === 'figure');
  assert.equal(previewPlainText(figure.caption), 'THE MAIN CAPTION that readers see.');
  assert.equal(document.references['fig:main'].number, '1');
  assert.equal(document.references['fig:a'].number, '1a');
  assert.equal(document.references['fig:b'].number, '1b');
});

test('a comment environment is parked text, like an iffalse block', () => {
  const source = article('Real prose.\n\\begin{comment}\nA shelved draft paragraph.\n\\end{comment}\nMore real prose.');
  const text = visibleText(source);
  assert.match(text, /Real prose/);
  assert.match(text, /More real prose/);
  assert.doesNotMatch(text, /shelved draft/);
});

test('an edit bordering masked source is reported as unfixable, not as a retry', () => {
  // The message matters: retrying an edit that straddles a `%` comment can
  // never succeed, and the old copy asked people to do exactly that.
  assert.equal(differsOnlyByMasking('            \n', ' % note here\n'), true);
  assert.equal(differsOnlyByMasking('hello world', 'hello world'), false, 'identical text is not a masking difference');
  assert.equal(differsOnlyByMasking('hello world', 'hello there'), false, 'a real mismatch is not masking');
  assert.equal(differsOnlyByMasking('short', 'much longer text'), false, 'masking never changes length');
  // Masking only ever blanks. A space on disk where the preview expected a
  // letter is a genuine divergence, not a hidden region.
  assert.equal(differsOnlyByMasking('a b', 'a  '), false);

  const source = article('Hello world % note here\nmore prose.');
  const paragraph = parseLatexPreview(source).blocks.find((block) => block.type === 'paragraph');
  assert.ok(paragraph?.type === 'paragraph');
  const leaf = textLeaves(paragraph.content).find((node) => node.source);
  assert.ok(leaf?.source);
  const at = leaf.text.indexOf('world') + 5;
  const change = previewTextChange(leaf.source, leaf.text, leaf.text.slice(0, at) + leaf.text.slice(at + 1));
  assert.ok(change);
  assert.notEqual(change.expected, source.slice(change.from, change.to));
  assert.equal(differsOnlyByMasking(change.expected, source.slice(change.from, change.to)), true);
});

test('floats keep one sequence across frames and callouts', () => {
  // A frame body is parsed as its own fragment, and a fresh parse used to start
  // every counter at zero — so a deck carrying one figure on each of two slides
  // called both of them "Figure 1", and the numbering of everything after them
  // restarted as well.
  const deck = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{One}
\begin{figure}
  \includegraphics{a}
  \caption{First}\label{fig:one}
\end{figure}
\end{frame}
\begin{frame}{Two}
\begin{figure}
  \includegraphics{b}
  \caption{Second}\label{fig:two}
\end{figure}
\end{frame}
\begin{figure}
  \includegraphics{c}
  \caption{Third}\label{fig:three}
\end{figure}
\end{document}`;
  const document = parseLatexPreview(deck);
  const numbers = nestedBlocks(document.blocks)
    .filter((block) => block.type === 'figure')
    .map((block) => (block.type === 'figure' ? block.number : ''));
  assert.deepEqual(numbers, ['1', '2', '3']);
  assert.equal(document.references['fig:one'].number, '1');
  assert.equal(document.references['fig:two'].number, '2');
  // And the document continues AFTER the fragment rather than from where it
  // stood before it — the half of this a per-frame counter would still get wrong.
  assert.equal(document.references['fig:three'].number, '3');

  // Callouts are adopted the same way, so equations inside one behave the same.
  const paper = parseLatexPreview(String.raw`\documentclass{article}
\begin{document}
\begin{equation}\label{eq:one}a = 1\end{equation}
\begin{block}{An aside}
\begin{equation}\label{eq:two}b = 2\end{equation}
\end{block}
\begin{equation}\label{eq:three}c = 3\end{equation}
\end{document}`);
  assert.equal(paper.references['eq:one'].number, '1');
  assert.equal(paper.references['eq:two'].number, '2');
  assert.equal(paper.references['eq:three'].number, '3');
});
