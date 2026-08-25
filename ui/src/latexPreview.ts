// A deliberately tolerant LaTeX -> document model for the Live visual editor.
//
// This is not a TeX engine: the PDF remains the exact result. The preview's job
// is different — make ordinary academic source editable immediately, even while
// the document is temporarily incomplete or contains project-local macros. A
// strict parser is a poor fit because one unknown macro makes a real paper
// disappear. This scanner preserves text, gives editable leaves exact source
// boundaries, understands common structures, and records every approximation.

export interface PreviewTextSource {
  /** Absolute UTF-16 offsets in the expanded preview source. */
  from: number;
  to: number;
  /** Exact source represented by this visible text leaf. */
  raw: string;
  /** Source offset at every boundary in `text` (length = text.length + 1). */
  boundaries: number[];
}

export type InlineNode =
  | { type: 'text'; text: string; source?: PreviewTextSource }
  | { type: 'strong' | 'em' | 'code' | 'underline' | 'smallcaps' | 'sup' | 'sub'; children: InlineNode[] }
  | { type: 'math'; tex: string }
  | { type: 'cite'; keys: string; mode: string }
  | { type: 'ref'; key: string; mode: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'footnote'; number: number }
  | { type: 'break' };

export interface PreviewFootnote {
  number: number;
  line: number;
  content: InlineNode[];
}

export interface PreviewReference {
  number: string;
  kind: 'section' | 'figure' | 'table' | 'equation' | 'other';
}

export interface PreviewTableCell {
  content: InlineNode[];
  colSpan?: number;
}

export interface PreviewTableRow {
  cells: PreviewTableCell[];
  header: boolean;
}

interface LocatedBlock { line: number; file?: string }

export type PreviewBlock =
  | (LocatedBlock & { type: 'title'; title: InlineNode[]; author: InlineNode[]; date: InlineNode[] })
  | (LocatedBlock & { type: 'heading'; level: 1 | 2 | 3 | 4; number?: string; content: InlineNode[] })
  | (LocatedBlock & { type: 'paragraph'; content: InlineNode[]; align?: 'center' })
  | (LocatedBlock & { type: 'list'; ordered: boolean; description: boolean; items: Array<{ label?: InlineNode[]; content: InlineNode[] }> })
  | (LocatedBlock & { type: 'math'; tex: string; number?: string })
  | (LocatedBlock & { type: 'figure'; number: string; caption: InlineNode[]; assets: string[] })
  | (LocatedBlock & { type: 'table'; number: string; caption: InlineNode[]; rows: PreviewTableRow[] })
  | (LocatedBlock & { type: 'quote'; content: InlineNode[] })
  | (LocatedBlock & { type: 'code'; content: string; language?: string })
  | (LocatedBlock & { type: 'image'; assets: string[] })
  | (LocatedBlock & {
      type: 'frame'; number: number; title: InlineNode[]; subtitle: InlineNode[];
      blocks: PreviewBlock[]; plain: boolean; overlays: boolean;
    })
  | (LocatedBlock & { type: 'columns'; columns: PreviewBlock[][] })
  | (LocatedBlock & {
      type: 'callout'; title: InlineNode[]; tone: 'neutral' | 'accent' | 'success';
      blocks: PreviewBlock[];
    })
  | (LocatedBlock & { type: 'notice'; label: string; detail?: string })
  | (LocatedBlock & { type: 'include'; path: string });

export interface PreviewDocument {
  kind: 'article' | 'presentation';
  aspectRatio: '4:3' | '16:9';
  blocks: PreviewBlock[];
  footnotes: PreviewFootnote[];
  references: Record<string, PreviewReference>;
  approximated: string[];
  wordCount: number;
}

function shiftInlineNodes(nodes: InlineNode[], offset: number, footnoteOffset: number): InlineNode[] {
  return nodes.map((node): InlineNode => {
    if (node.type === 'text') {
      return node.source ? {
        ...node,
        source: {
          ...node.source,
          from: node.source.from + offset,
          to: node.source.to + offset,
          boundaries: node.source.boundaries.map((boundary) => boundary + offset),
        },
      } : node;
    }
    if (node.type === 'footnote') return { ...node, number: node.number + footnoteOffset };
    if ('children' in node) return { ...node, children: shiftInlineNodes(node.children, offset, footnoteOffset) };
    return node;
  });
}

/** Rebase a recursively parsed presentation fragment onto the complete source.
 * Keeping this transformation structural is what lets prose inside a frame,
 * callout, or column retain the same smallest-slice editing guarantees as an
 * ordinary article paragraph. */
function shiftPreviewBlock(block: PreviewBlock, offset: number, lineDelta: number, footnoteOffset: number): PreviewBlock {
  const located = { ...block, line: block.line + lineDelta };
  if (block.type === 'title') return {
    ...located,
    title: shiftInlineNodes(block.title, offset, footnoteOffset),
    author: shiftInlineNodes(block.author, offset, footnoteOffset),
    date: shiftInlineNodes(block.date, offset, footnoteOffset),
  } as PreviewBlock;
  if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote') {
    return { ...located, content: shiftInlineNodes(block.content, offset, footnoteOffset) } as PreviewBlock;
  }
  if (block.type === 'list') return {
    ...located,
    items: block.items.map((item) => ({
      ...(item.label ? { label: shiftInlineNodes(item.label, offset, footnoteOffset) } : {}),
      content: shiftInlineNodes(item.content, offset, footnoteOffset),
    })),
  } as PreviewBlock;
  if (block.type === 'figure') return { ...located, caption: shiftInlineNodes(block.caption, offset, footnoteOffset) } as PreviewBlock;
  if (block.type === 'table') return {
    ...located,
    caption: shiftInlineNodes(block.caption, offset, footnoteOffset),
    rows: block.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => ({ ...cell, content: shiftInlineNodes(cell.content, offset, footnoteOffset) })),
    })),
  } as PreviewBlock;
  if (block.type === 'frame') return {
    ...located,
    title: shiftInlineNodes(block.title, offset, footnoteOffset),
    subtitle: shiftInlineNodes(block.subtitle, offset, footnoteOffset),
    blocks: block.blocks.map((child) => shiftPreviewBlock(child, offset, lineDelta, footnoteOffset)),
  } as PreviewBlock;
  if (block.type === 'columns') return {
    ...located,
    columns: block.columns.map((column) => column.map((child) => shiftPreviewBlock(child, offset, lineDelta, footnoteOffset))),
  } as PreviewBlock;
  if (block.type === 'callout') return {
    ...located,
    title: shiftInlineNodes(block.title, offset, footnoteOffset),
    blocks: block.blocks.map((child) => shiftPreviewBlock(child, offset, lineDelta, footnoteOffset)),
  } as PreviewBlock;
  return located as PreviewBlock;
}

interface Group {
  value: string;
  start: number;
  end: number;
}

interface Macro {
  name: string;
  starred: boolean;
  start: number;
  headEnd: number;
  end: number;
  options: Group[];
  args: Group[];
}

interface ParseContext {
  footnotes: PreviewFootnote[];
  approximated: Set<string>;
  line: number;
  /** Absolute source offset for the first character of the parsed fragment. */
  offset?: number;
}

interface SourceLine {
  start: number;
  end: number;
  text: string;
  number: number;
}

const FORMATTING: Record<string, InlineNode['type']> = {
  textbf: 'strong', emph: 'em', textit: 'em', textsl: 'em',
  texttt: 'code', underline: 'underline', uline: 'underline',
  textsc: 'smallcaps', textsuperscript: 'sup', textsubscript: 'sub',
};

const LAYOUT_ONLY = new Set([
  'centering', 'raggedright', 'raggedleft', 'noindent', 'indent', 'par',
  'small', 'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'LARGE', 'huge', 'Huge',
  'normalfont', 'rmfamily', 'sffamily', 'ttfamily', 'bfseries', 'itshape', 'slshape',
  'selectfont', 'arraybackslash', 'onehalfspacing', 'singlespacing', 'doublespacing', 'maketitle',
  'newpage', 'clearpage', 'pagebreak', 'nopagebreak', 'allowbreak', 'linebreak',
  'toprule', 'midrule', 'bottomrule', 'hline', 'addlinespace', 'tableofcontents',
  'pause', 'onslide', 'titlepage', 'againframe', 'mode',
]);

const DROP_WITH_ARGS = new Set([
  'label', 'index', 'thispagestyle', 'pagestyle', 'vspace', 'hspace', 'vskip', 'hskip',
  'setlength', 'addtolength', 'setcounter', 'addtocounter', 'renewcommand', 'newcommand',
  'providecommand', 'DeclareRobustCommand', 'fontsize', 'fontencoding', 'hypertarget',
  'phantomsection', 'bibliographystyle', 'bibliography', 'includegraphics', 'cline', 'begin', 'end',
  'frametitle', 'framesubtitle', 'transduration', 'transblindshorizontal', 'transblindsvertical',
]);

const SYMBOLS: Record<string, string> = {
  LaTeX: 'LaTeX', TeX: 'TeX', ldots: '…', dots: '…', textellipsis: '…',
  textemdash: '—', textendash: '–', copyright: '©', textcopyright: '©',
  pounds: '£', euro: '€', EUR: '€', S: '§', P: '¶', ae: 'æ', AE: 'Æ',
  oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', ss: 'ß', o: 'ø', O: 'Ø',
  textasciitilde: '~', textbackslash: '\\', checkmark: '✓', and: ' · ',
  quad: '  ', qquad: '    ', thinspace: ' ', enspace: ' ', emspace: ' ',
  ' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '',
};

const ACCENTS: Record<string, string> = {
  "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303',
  '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030c', H: '\u030b',
  c: '\u0327', k: '\u0328', r: '\u030a', d: '\u0323', b: '\u0331',
};

function escapedAt(text: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

/** Replace comments with spaces, retaining every offset and newline. */
export function maskLatexComments(source: string): string {
  // split('') keeps JavaScript UTF-16 offsets stable; spreading would collapse
  // a surrogate pair and shift every source location after an emoji.
  const chars = source.split('');
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '%' || escapedAt(source, i)) continue;
    while (i < chars.length && chars[i] !== '\n' && chars[i] !== '\r') chars[i++] = ' ';
  }
  return chars.join('');
}

function maskLatexLiteralRegions(source: string): string {
  const blank = (literal: string) => literal.replace(/[^\r\n]/g, ' ');
  return source
    .replace(
      /\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}[\s\S]*?\\end\s*\{\1\}/g,
      blank,
    )
    .replace(/\\begin\s*\{(?:verbatim\*?|Verbatim|lstlisting|minted|comment)\}[\s\S]*$/g, blank)
    .replace(/\\verb\*?([^A-Za-z\s\r\n]).*?\1/g, blank);
}

/** Hide the inactive branch of explicit `\iffalse` blocks while preserving
 * every character offset and newline. TeX sources commonly park obsolete
 * tables this way; Live should neither display nor fetch their missing inputs.
 * Unknown conditionals remain visible because evaluating arbitrary TeX tests is
 * the compiler's job, but they are tracked so nested false blocks close safely. */
export function maskLatexFalseBlocks(source: string): string {
  const chars = source.split('');
  const scan = maskLatexLiteralRegions(source);
  const stack: Array<{ name: string; parentVisible: boolean }> = [];
  const token = /\\(if[A-Za-z@]*|else|fi)\b/g;
  let visible = true;
  let cursor = 0;
  const mask = (from: number, to: number) => {
    for (let index = from; index < to; index++) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    }
  };

  for (let match = token.exec(scan); match; match = token.exec(scan)) {
    if (!visible) mask(cursor, match.index);
    const name = match[1];
    const end = match.index + match[0].length;
    if (name.startsWith('if')) {
      const parentVisible = visible;
      stack.push({ name, parentVisible });
      if (name === 'iffalse' || !parentVisible) {
        mask(match.index, end);
        visible = false;
      }
    } else if (name === 'else') {
      const frame = stack[stack.length - 1];
      if (frame?.name === 'iffalse' || frame?.parentVisible === false) {
        mask(match.index, end);
        visible = Boolean(frame?.parentVisible && frame.name === 'iffalse');
      }
    } else {
      const frame = stack.pop();
      if (frame?.name === 'iffalse' || frame?.parentVisible === false || !visible) mask(match.index, end);
      visible = frame?.parentVisible ?? true;
    }
    cursor = end;
  }
  if (!visible) mask(cursor, source.length);
  return chars.join('');
}

/** Hide Beamer overlay selectors while retaining exact source offsets.
 *
 * Live shows the union of all overlay content in one editable frame card. A
 * selector such as `<2->` controls when content appears in the PDF; it is not
 * prose and should never leak into the visual editor as literal text. The
 * expression is intentionally restricted to overlay-aware Beamer commands so
 * ordinary mathematical comparisons remain untouched. */
export function maskBeamerOverlays(source: string): string {
  const chars = source.split('');
  const scan = maskLatexLiteralRegions(source);
  // Deliberately not `\s*`: an overlay selector sits on the same line as its
  // command. Allowing a newline between them let `\item` on one line and a `<`
  // on the next blank out real prose.
  const overlay = /\\(?:item|only|uncover|visible|invisible|onslide|alt|temporal|alert|action|pause)\*?[^\S\r\n]*<[^>\r\n]*>/g;
  for (let match = overlay.exec(scan); match; match = overlay.exec(scan)) {
    const open = match[0].indexOf('<');
    if (open < 0) continue;
    const from = match.index + open;
    for (let index = from; index < match.index + match[0].length; index++) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    }
  }
  return chars.join('');
}

export interface PreviewSourceLocation { file: string; line: number; editable?: boolean }
export interface ExpandedPreviewSource { text: string; locations: PreviewSourceLocation[] }
export interface PreviewIncludeFile { path?: string; content: string; editable?: boolean }
export interface ExpandLatexIncludeOptions { allowParent?: boolean }

export function sourceWithPreviewLocations(file: string, source: string): ExpandedPreviewSource {
  const lines = source.split(/\r?\n/);
  return { text: lines.join('\n'), locations: lines.map((_, index) => ({ file, line: index + 1 })) };
}

export function resolveLatexInclude(parent: string, requested: string, allowParent = false): string | null {
  let target = requested.trim().replace(/\\/g, '/');
  if (!target || /^(?:[a-z]+:|\/)/i.test(target)) return null;
  if (!/\.[A-Za-z0-9]+$/.test(target)) target += '.tex';
  if (!/\.tex$/i.test(target)) return null;
  const parentParts = parent.replace(/\\/g, '/').split('/').slice(0, -1);
  const parts = [...parentParts, ...target.split('/')];
  const clean: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (clean.length && clean[clean.length - 1] !== '..') clean.pop();
      else if (allowParent) clean.push('..');
      else return null;
    }
    else clean.push(part);
  }
  return clean.join('/');
}

/** Expand body \input/\include calls—including ones wrapped by resizebox—while
 * retaining a map back to every original file and line. Preamble inputs (fonts,
 * generated maps) are deliberately left to TeX. */
export async function expandLatexIncludes(
  file: string,
  source: string,
  load: (path: string, signal: AbortSignal) => Promise<string | PreviewIncludeFile | null>,
  signal: AbortSignal,
  options: ExpandLatexIncludeOptions = {},
  visited = new Set<string>([file]),
  depth = 0,
): Promise<ExpandedPreviewSource> {
  if (depth >= 8) return sourceWithPreviewLocations(file, source);
  const lines = source.split(/\r?\n/);
  const scanLines = maskLatexFalseBlocks(maskLatexComments(source)).split(/\r?\n/);
  const output: string[] = [];
  const locations: PreviewSourceLocation[] = [];
  const hasDocument = /\\begin\s*\{document\}/.test(scanLines.join('\n'));
  let inDocument = !hasDocument;
  let literalEnvironment: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const visible = scanLines[index] ?? '';
    if (/\\begin\s*\{document\}/.test(visible)) inDocument = true;

    // Literal environments may contain documentation examples such as
    // `\input{secret}`. They are prose, not dependencies, and must never cause
    // a file request merely because Live is open.
    if (literalEnvironment) {
      output.push(line);
      locations.push({ file, line: index + 1 });
      if (new RegExp(`\\\\end\\s*\\{${literalEnvironment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`).test(visible)) {
        literalEnvironment = null;
      }
      continue;
    }
    const literalBegin = /\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}/.exec(visible);
    if (literalBegin) {
      output.push(line);
      locations.push({ file, line: index + 1 });
      const tail = visible.slice(literalBegin.index + literalBegin[0].length);
      if (!new RegExp(`\\\\end\\s*\\{${literalBegin[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`).test(tail)) {
        literalEnvironment = literalBegin[1];
      }
      continue;
    }

    const includeVisible = visible.replace(/\\verb\*?([^A-Za-z\s]).*?\1/g, (literal) => ' '.repeat(literal.length));
    const includeRe = /\\(?:input|include)\s*\{([^{}]+)\}/g;
    const includes = inDocument
      ? [...includeVisible.matchAll(includeRe)].filter((match) => !escapedAt(includeVisible, match.index ?? 0))
      : [];
    let cursor = 0;
    let expandedAny = false;
    for (const include of includes) {
      const child = resolveLatexInclude(file, include[1], options.allowParent === true);
      if (!child || visited.has(child)) continue;
      const loaded = await load(child, signal).catch((error) => {
        if (signal.aborted) throw error;
        return null;
      });
      if (loaded === null) continue;
      const childSource = typeof loaded === 'string' ? loaded : loaded.content;
      const childFile = typeof loaded === 'string' ? child : loaded.path ?? child;
      if (visited.has(childFile)) continue;
      const expanded = await expandLatexIncludes(
        childFile,
        childSource,
        load,
        signal,
        options,
        new Set(visited).add(childFile),
        depth + 1,
      );
      const childLocations = typeof loaded !== 'string' && loaded.editable === false
        ? expanded.locations.map((location) => ({ ...location, editable: false }))
        : expanded.locations;

      // Put wrappers such as `\resizebox{...}{!}{` and their closing brace on
      // separate preview lines. The TeX meaning is unchanged, while every table
      // cell keeps an unambiguous line mapping to its generated source file.
      output.push(line.slice(cursor, include.index));
      locations.push({ file, line: index + 1 });
      output.push(...expanded.text.split('\n'));
      locations.push(...childLocations);
      cursor = include.index! + include[0].length;
      expandedAny = true;
    }
    if (expandedAny) {
      output.push(line.slice(cursor));
      locations.push({ file, line: index + 1 });
    } else {
      output.push(line);
      locations.push({ file, line: index + 1 });
    }
    if (/\\end\s*\{document\}/.test(visible)) inDocument = false;
  }
  return { text: output.join('\n'), locations };
}

function readGroup(text: string, at: number): Group | null {
  const open = text[at];
  const close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return null;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (escapedAt(text, i)) continue;
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return { value: text.slice(at + 1, i), start: at, end: i + 1 };
  }
  // Incomplete source is normal while typing: preserve the partial argument.
  return { value: text.slice(at + 1), start: at, end: text.length };
}

function readMacro(text: string, at: number): Macro | null {
  if (text[at] !== '\\') return null;
  let cursor = at + 1;
  let name = '';
  if (/[A-Za-z@]/.test(text[cursor] ?? '')) {
    while (/[A-Za-z@]/.test(text[cursor] ?? '')) name += text[cursor++];
  } else {
    name = text[cursor] ?? '';
    cursor++;
  }
  if (!name) return null;
  const starred = text[cursor] === '*';
  if (starred) cursor++;
  const headEnd = cursor;
  const options: Group[] = [];
  const args: Group[] = [];
  let end = cursor;
  for (let count = 0; count < 6; count++) {
    let p = end;
    while (/\s/.test(text[p] ?? '')) p++;
    const group = readGroup(text, p);
    if (!group) break;
    if (text[p] === '[') options.push(group); else args.push(group);
    end = group.end;
  }
  return { name, starred, start: at, headEnd, end, options, args };
}

function findCommand(text: string, name: string, from = 0): Macro | null {
  const re = new RegExp(`\\\\${name}\\b`, 'g');
  re.lastIndex = from;
  for (let found = re.exec(text); found; found = re.exec(text)) {
    const macro = readMacro(text, found.index);
    if (macro?.name === name) return macro;
  }
  return null;
}

const SUBFLOAT = 'subfigure|subtable|subfloat|subcaptionblock';

/** The caption belonging to the float itself, not to a panel inside it.
 * Sub-captions come first in the source, so taking the first `\caption` labelled
 * a two-panel figure with "Left panel shows A" and hid the real caption. */
function findFloatCaption(text: string): Macro | null {
  const token = new RegExp(`\\\\(?:(begin)|(end))\\s*\\{(?:${SUBFLOAT}|minipage|wrapfigure)\\*?\\}|\\\\caption(?![A-Za-z])`, 'g');
  let depth = 0;
  let outermost: Macro | null = null;
  let first: Macro | null = null;
  for (let found = token.exec(text); found; found = token.exec(text)) {
    if (found[1]) { depth++; continue; }
    if (found[2]) { depth = Math.max(0, depth - 1); continue; }
    const macro = readMacro(text, found.index);
    if (!macro) continue;
    first ??= macro;
    if (depth === 0) outermost = macro;
  }
  return outermost ?? first;
}

function visibleTypographyProjection(value: string, absoluteStart = 0): { text: string; boundaries: number[] } {
  let text = '';
  const boundaries = [absoluteStart];
  const emit = (visible: string, rawStart: number, rawEnd: number) => {
    text += visible;
    for (let index = 0; index < visible.length; index++) {
      boundaries.push(absoluteStart + (index === visible.length - 1 ? rawEnd : rawStart));
    }
  };

  for (let at = 0; at < value.length;) {
    if (value.startsWith('---', at)) { emit('—', at, at + 3); at += 3; continue; }
    if (value.startsWith('--', at)) { emit('–', at, at + 2); at += 2; continue; }
    if (value.startsWith('``', at)) { emit('“', at, at + 2); at += 2; continue; }
    if (value.startsWith("''", at)) { emit('”', at, at + 2); at += 2; continue; }
    if (value[at] === '~') { emit('\u00a0', at, at + 1); at++; continue; }
    if (/\s/.test(value[at])) {
      const start = at;
      while (/\s/.test(value[at] ?? '')) at++;
      emit(' ', start, at);
      continue;
    }
    emit(value[at], at, at + 1);
    at++;
  }
  return { text, boundaries };
}

function visibleTypography(text: string): string {
  return visibleTypographyProjection(text).text;
}

function appendTextNode(nodes: InlineNode[], node: Extract<InlineNode, { type: 'text' }>): void {
  const previous = nodes[nodes.length - 1];
  if (
    previous?.type === 'text' &&
    previous.source &&
    node.source &&
    previous.source.to === node.source.from
  ) {
    previous.text += node.text;
    previous.source.to = node.source.to;
    previous.source.raw += node.source.raw;
    // Appended one at a time, deliberately. `push(...boundaries)` spreads every
    // boundary into an argument list, and a paragraph of 125k plain characters
    // following an atomic node (`\%`, `\&`, `\'{e}`) is enough arguments to
    // overflow the call stack — which killed the whole Live pane, Retry
    // included, on nothing more exotic than a long paragraph.
    for (let index = 1; index < node.source.boundaries.length; index++) {
      previous.source.boundaries.push(node.source.boundaries[index]);
    }
    return;
  }
  nodes.push(node);
}

function pushText(nodes: InlineNode[], value: string, from?: number, to?: number): void {
  const projection = visibleTypographyProjection(value, from ?? 0);
  if (!projection.text) return;
  appendTextNode(nodes, {
    type: 'text',
    text: projection.text,
    ...(from !== undefined && to !== undefined ? {
      source: { from, to, raw: value, boundaries: projection.boundaries },
    } : {}),
  });
}

function pushAtomicText(nodes: InlineNode[], value: string, raw: string, from?: number, to?: number): void {
  if (!value) return;
  const mapped = from !== undefined && to !== undefined;
  const boundaries = mapped
    ? [from, ...Array(Math.max(0, value.length - 1)).fill(from), to]
    : [];
  appendTextNode(nodes, {
    type: 'text',
    text: value,
    ...(mapped ? { source: { from, to, raw, boundaries } } : {}),
  });
}

function childrenFor(group: Group | undefined, context: ParseContext): InlineNode[] {
  return group ? parseInline(group.value, {
    ...context,
    offset: context.offset === undefined ? undefined : context.offset + group.start + 1,
  }) : [];
}

function lastUsedEnd(macro: Macro, argCount: number): number {
  if (argCount > 0 && macro.args[argCount - 1]) return macro.args[argCount - 1].end;
  if (macro.options.length) return macro.options[macro.options.length - 1].end;
  return macro.headEnd;
}

/** The optional argument of a break macro (`\\[2pt]`, `\pagebreak[4]`) is a
 * length or a penalty, never prose — but only when the bracket touches the
 * macro and actually closes. `\noindent [1] Smith et al.` opens a reference
 * entry, and `readGroup` answers an unmatched `[` with a group running to the
 * end of the document, so consuming one on trust loses the rest of the paper. */
const BREAK_WITH_LENGTH = new Set(['pagebreak', 'nopagebreak', 'linebreak', '\\']);

/** Whether a group really ended, as opposed to `readGroup` reaching the end of
 * the source looking for a delimiter that was never there. Skipping over an
 * unterminated group discards everything after it. */
function closedGroup(text: string, group: Group): boolean {
  return text[group.end - 1] === (text[group.start] === '{' ? '}' : ']');
}

function breakLengthEnd(macro: Macro, text: string): number {
  if (!BREAK_WITH_LENGTH.has(macro.name)) return macro.headEnd;
  const option = macro.options[0];
  if (!option || option.start !== macro.headEnd || !closedGroup(text, option)) return macro.headEnd;
  return option.end;
}

export function parseInline(text: string, context: ParseContext): InlineNode[] {
  const nodes: InlineNode[] = [];
  let plain = '';
  let plainStart = 0;
  const appendPlain = (value: string, at: number) => {
    if (!plain) plainStart = at;
    plain += value;
  };
  const flush = () => {
    if (plain) {
      const from = context.offset === undefined ? undefined : context.offset + plainStart;
      pushText(nodes, plain, from, from === undefined ? undefined : from + plain.length);
    }
    plain = '';
  };

  for (let i = 0; i < text.length;) {
    const char = text[i];

    if (char === '$' && !escapedAt(text, i)) {
      const doubled = text[i + 1] === '$';
      const token = doubled ? '$$' : '$';
      let end = i + token.length;
      while ((end = text.indexOf(token, end)) >= 0 && escapedAt(text, end)) end += token.length;
      if (end >= 0) {
        flush();
        const tex = text.slice(i + token.length, end).trim();
        if (tex) nodes.push({ type: 'math', tex });
        i = end + token.length;
        continue;
      }
    }

    if (char === '{' && !escapedAt(text, i)) {
      const group = readGroup(text, i);
      if (group) {
        flush();
        nodes.push(...childrenFor(group, context));
        i = group.end;
        continue;
      }
    }

    if (char !== '\\') { appendPlain(char, i); i++; continue; }

    // \verb uses its next character as a delimiter rather than a brace.
    const verb = /^\\verb\*?([^A-Za-z\s])/.exec(text.slice(i));
    if (verb) {
      const end = text.indexOf(verb[1], i + verb[0].length);
      if (end >= 0) {
        flush();
        const value = text.slice(i + verb[0].length, end);
        const children: InlineNode[] = [];
        const from = context.offset === undefined ? undefined : context.offset + i + verb[0].length;
        pushText(children, value, from, from === undefined ? undefined : from + value.length);
        nodes.push({ type: 'code', children });
        i = end + 1;
        continue;
      }
    }

    if (text.startsWith('\\(', i)) {
      const end = text.indexOf('\\)', i + 2);
      if (end >= 0) {
        flush();
        nodes.push({ type: 'math', tex: text.slice(i + 2, end).trim() });
        i = end + 2;
        continue;
      }
    }

    const macro = readMacro(text, i);
    if (!macro) { appendPlain('\\', i); i++; continue; }
    flush();

    if (macro.name === '\\') {
      nodes.push({ type: 'break' });
      i = breakLengthEnd(macro, text);
      continue;
    }
    if (['%', '&', '_', '#', '$', '{', '}'].includes(macro.name)) {
      const from = context.offset === undefined ? undefined : context.offset + macro.start;
      const to = context.offset === undefined ? undefined : context.offset + macro.headEnd;
      pushAtomicText(nodes, macro.name, text.slice(macro.start, macro.headEnd), from, to);
      i = macro.headEnd;
      continue;
    }

    const format = FORMATTING[macro.name];
    if (format && macro.args[0]) {
      nodes.push({ type: format as 'strong', children: childrenFor(macro.args[0], context) });
      i = lastUsedEnd(macro, 1);
      continue;
    }

    if (ACCENTS[macro.name] && macro.args[0]) {
      const letter = previewPlainText(childrenFor(macro.args[0], context));
      const end = lastUsedEnd(macro, 1);
      const from = context.offset === undefined ? undefined : context.offset + macro.start;
      const to = context.offset === undefined ? undefined : context.offset + end;
      pushAtomicText(nodes, (letter + ACCENTS[macro.name]).normalize('NFC'), text.slice(macro.start, end), from, to);
      i = end;
      continue;
    }

    if (macro.name === 'href' && macro.args.length >= 2) {
      nodes.push({ type: 'link', href: macro.args[0].value.trim(), children: childrenFor(macro.args[1], context) });
      i = lastUsedEnd(macro, 2);
      continue;
    }
    if ((macro.name === 'url' || macro.name === 'email') && macro.args[0]) {
      const href = macro.name === 'email' ? `mailto:${macro.args[0].value.trim()}` : macro.args[0].value.trim();
      nodes.push({
        type: 'link',
        href,
        children: parseTrimmedInline(
          macro.args[0].value,
          context.offset === undefined ? undefined : context.offset + macro.args[0].start + 1,
          context,
          context.line,
        ),
      });
      i = lastUsedEnd(macro, 1);
      continue;
    }

    if (/^cite[a-zA-Z]*$/.test(macro.name) && macro.args[0]) {
      nodes.push({ type: 'cite', keys: macro.args[0].value.split(',').map((key) => key.trim()).filter(Boolean).join(', '), mode: macro.name });
      i = lastUsedEnd(macro, 1);
      continue;
    }
    if (/^(?:ref|pageref|eqref|autoref|cref|Cref)$/.test(macro.name) && macro.args[0]) {
      nodes.push({ type: 'ref', key: macro.args[0].value.trim(), mode: macro.name });
      i = lastUsedEnd(macro, 1);
      continue;
    }

    if ((macro.name === 'footnote' || macro.name === 'thanks') && macro.args[0]) {
      const number = context.footnotes.length + 1;
      const content = childrenFor(macro.args[0], context);
      context.footnotes.push({ number, line: context.line, content });
      nodes.push({ type: 'footnote', number });
      i = lastUsedEnd(macro, 1);
      continue;
    }

    if (macro.name === 'textcolor' || macro.name === 'colorbox' || macro.name === 'fcolorbox') {
      const contentArg = macro.args[macro.name === 'fcolorbox' ? 2 : 1];
      if (contentArg) nodes.push(...childrenFor(contentArg, context));
      i = lastUsedEnd(macro, macro.name === 'fcolorbox' ? 3 : 2);
      continue;
    }
    if (['texorpdfstring', 'foreignlanguage'].includes(macro.name) && macro.args[0]) {
      const contentArg = macro.name === 'foreignlanguage' ? macro.args[1] : macro.args[0];
      if (contentArg) nodes.push(...childrenFor(contentArg, context));
      i = lastUsedEnd(macro, macro.name === 'foreignlanguage' ? 2 : 1);
      continue;
    }
    if (['mbox', 'makebox', 'parbox', 'raisebox', 'resizebox', 'scalebox', 'adjustbox', 'multicolumn', 'multirow', 'makecell', 'shortstack'].includes(macro.name) && macro.args.length) {
      const contentArg = macro.args[macro.args.length - 1];
      nodes.push(...childrenFor(contentArg, context));
      i = contentArg.end;
      continue;
    }

    if (SYMBOLS[macro.name] !== undefined) {
      // Presentation macros are intentionally atomic. Their exact source stays
      // untouched; double-clicking the rendered word still opens Code.
      pushAtomicText(nodes, SYMBOLS[macro.name], text.slice(macro.start, macro.headEnd));
      i = macro.headEnd;
      continue;
    }
    if (LAYOUT_ONLY.has(macro.name)) {
      if (macro.name === 'par' || macro.name === 'linebreak') nodes.push({ type: 'break' });
      i = breakLengthEnd(macro, text);
      continue;
    }
    if (DROP_WITH_ARGS.has(macro.name)) {
      // Half-typed source is normal. Skipping past an argument that never closes
      // (`\vspace{1em Prose…`) would drop every remaining paragraph, so stop at
      // the last argument that really ended.
      let end = macro.headEnd;
      for (const argument of macro.args) {
        if (!closedGroup(text, argument)) break;
        end = argument.end;
      }
      i = end;
      continue;
    }

    // Project-local presentation macros commonly take style/configuration
    // arguments first and visible content last (for example \pill{blue}{Text}).
    // Preserving the last argument gives a useful tolerant rendering without
    // inventing project-specific command definitions. A last argument that
    // renders to nothing is a unit or a key rather than content — \SI{5}{\metre}
    // would otherwise show nothing at all — so fall back to the nearest earlier
    // argument that does show something.
    if (macro.args.length) {
      context.approximated.add(`\\${macro.name}`);
      let children = childrenFor(macro.args[macro.args.length - 1], context);
      for (let back = macro.args.length - 2; back >= 0 && !previewPlainText(children); back--) {
        children = childrenFor(macro.args[back], context);
      }
      nodes.push(...children);
      i = macro.args[macro.args.length - 1].end;
      continue;
    }

    context.approximated.add(`\\${macro.name}`);
    i = macro.headEnd;
  }
  flush();
  return nodes.filter((node) => node.type !== 'text' || node.text.length > 0);
}

export function previewPlainText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'text') return node.text;
    if ('children' in node) return previewPlainText(node.children);
    if (node.type === 'math') return node.tex;
    if (node.type === 'cite') return `[${node.keys}]`;
    if (node.type === 'ref') return node.key;
    if (node.type === 'footnote') return '';
    return ' ';
  }).join('').replace(/\s+/g, ' ').trim();
}

export interface PreviewTextChange {
  from: number;
  to: number;
  insert: string;
  expected: string;
}

/** True when the source the preview expected differs from the file only where
 * masking blanked it to spaces — a `%` comment, an `\iffalse` branch, a Beamer
 * overlay. Such a span can never be spliced from Live, so the message it earns
 * has to say where to go instead of inviting a retry that cannot succeed. */
export function differsOnlyByMasking(expected: string, actual: string): boolean {
  if (expected.length !== actual.length || expected === actual) return false;
  for (let index = 0; index < expected.length; index++) {
    if (expected[index] !== actual[index] && expected[index] !== ' ') return false;
  }
  return true;
}

/** Escape text typed in the visual surface without interpreting it as LaTeX. */
export function escapeLatexTextInput(text: string): string {
  let escaped = '';
  for (const character of text.replace(/\r\n?/g, '\n')) {
    if (character === '\u00a0') escaped += '~';
    else if (character === '\\') escaped += '\\textbackslash{}';
    else if ('{}&%$#_'.includes(character)) escaped += `\\${character}`;
    else if (character === '^') escaped += '\\textasciicircum{}';
    else if (character === '~') escaped += '\\textasciitilde{}';
    else escaped += character;
  }
  return escaped;
}

/** Translate Chromium's plaintext-contenteditable representation of Enter
 * into a LaTeX paragraph break. This is used only after a visual structural
 * edit, so pre-existing source whitespace remains byte-for-byte untouched. */
export function contentEditableParagraphDraft(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .replace(/\n/g, '\n\n');
}

/** Convert one contenteditable mutation into the smallest possible source
 * replacement. Unchanged typography, whitespace, macros, citations, math, and
 * comments outside that changed slice remain byte-for-byte untouched. */
export function previewTextChange(
  source: PreviewTextSource,
  before: string,
  after: string,
): PreviewTextChange | null {
  if (before === after) return null;
  if (source.boundaries.length !== before.length + 1) return null;

  let prefix = 0;
  const common = Math.min(before.length, after.length);
  while (prefix < common && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;

  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  const from = source.boundaries[prefix];
  const to = source.boundaries[oldEnd];
  if (from === undefined || to === undefined || from > to) return null;
  return {
    from,
    to,
    insert: escapeLatexTextInput(after.slice(prefix, newEnd)),
    expected: source.raw.slice(from - source.from, to - source.from),
  };
}

function labelsIn(text: string): string[] {
  return [...text.matchAll(/\\label\s*\{([^{}]+)\}/g)].map((match) => match[1].trim()).filter(Boolean);
}

function environmentAt(text: string, at: number): { name: string; innerStart: number; endStart: number; end: number } | null {
  const begin = /^\\begin\s*\{([^{}]+)\}/.exec(text.slice(at));
  if (!begin) return null;
  const name = begin[1];
  const token = new RegExp(`\\\\(begin|end)\\s*\\{${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g');
  token.lastIndex = at;
  let depth = 0;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    if (match[1] === 'begin') depth++;
    else if (--depth === 0) return { name, innerStart: at + begin[0].length, endStart: match.index, end: match.index + match[0].length };
  }
  return { name, innerStart: at + begin[0].length, endStart: text.length, end: text.length };
}

function splitAtTopLevel(text: string, kind: 'row' | 'cell'): Array<{ value: string; start: number }> {
  const parts: Array<{ value: string; start: number }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (escapedAt(text, i)) continue;
    if (text[i] === '{' || text[i] === '[') depth++;
    else if (text[i] === '}' || text[i] === ']') depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    if (kind === 'cell' && text[i] === '&') {
      parts.push({ value: text.slice(start, i), start });
      start = i + 1;
    } else if (kind === 'row' && text[i] === '\\' && text[i + 1] === '\\') {
      parts.push({ value: text.slice(start, i), start });
      i++;
      while (/\s/.test(text[i + 1] ?? '')) i++;
      if (text[i + 1] === '[') {
        const option = readGroup(text, i + 1);
        if (option) i = option.end - 1;
      }
      start = i + 1;
    }
  }
  parts.push({ value: text.slice(start), start });
  return parts;
}

function maskTableNoise(text: string): string {
  // Spaces preserve source offsets, unlike deletion. That matters because a
  // generated-table cell may still be editable when its file is inside the
  // selected project, and every visible character must map back exactly.
  return text.replace(
    /\\(?:toprule|midrule|bottomrule|hline)\b|\\(?:cline|cmidrule)(?:\s*\([^)]*\))?\s*\{[^{}]*\}|\\addlinespace(?:\s*\[[^\]]*\])?|\\specialrule(?:\s*\{[^{}]*\}){1,3}/g,
    (noise) => ' '.repeat(noise.length),
  );
}

function trimTableNoise(text: string): string {
  return maskTableNoise(text)
    .replace(/\\(?:centering|raggedright|arraybackslash|small|footnotesize)\b/g, ' ')
    .trim();
}

function parseTrimmedInline(text: string, absoluteStart: number | undefined, context: ParseContext, line: number): InlineNode[] {
  const leading = text.length - text.trimStart().length;
  const trailing = text.length - text.trimEnd().length;
  const end = Math.max(leading, text.length - trailing);
  const value = text.slice(leading, end);
  return value ? parseInline(value, {
    ...context,
    line,
    offset: absoluteStart === undefined ? undefined : absoluteStart + leading,
  }) : [];
}

function paragraphParts(text: string, start: number, context: ParseContext, lineOf: (offset: number) => number, align?: 'center'): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  const re = /(?:\r?\n)\s*(?:\r?\n)+/g;
  let cursor = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const raw = text.slice(cursor, match.index);
    if (raw.trim()) {
      const line = lineOf(start + cursor);
      const nodes = parseTrimmedInline(raw, start + cursor, context, line);
      if (previewPlainText(nodes)) blocks.push({ type: 'paragraph', line, content: nodes, align });
    }
    cursor = match.index + match[0].length;
  }
  const raw = text.slice(cursor);
  if (raw.trim()) {
    const line = lineOf(start + cursor);
    const nodes = parseTrimmedInline(raw, start + cursor, context, line);
    if (previewPlainText(nodes)) blocks.push({ type: 'paragraph', line, content: nodes, align });
  }
  return blocks;
}

function titleMetadata(source: string, context: ParseContext): { title: InlineNode[]; author: InlineNode[]; date: InlineNode[]; line: number; titleOffset: number } | null {
  const title = findCommand(source, 'title');
  if (!title?.args[0]) return null;
  const stop = title.args[0].value.search(/\\(?:thanks|author|date)\b/);
  const titleRaw = stop >= 0 ? title.args[0].value.slice(0, stop) : title.args[0].value;
  const author = findCommand(source, 'author', title.start) ?? findCommand(source, 'author');
  const date = findCommand(source, 'date', title.start) ?? findCommand(source, 'date');
  return {
    title: parseInline(titleRaw, { ...context, offset: title.args[0].start + 1 }),
    author: author?.args[0] ? parseInline(author.args[0].value, { ...context, offset: author.args[0].start + 1 }) : [],
    date: date?.args[0] ? parseInline(date.args[0].value, { ...context, offset: date.args[0].start + 1 }) : [],
    line: source.slice(0, title.start).split(/\r?\n/).length,
    titleOffset: title.start,
  };
}

function letterNumber(value: number): string {
  let n = value;
  let out = '';
  while (n > 0) { n--; out = String.fromCharCode(65 + n % 26) + out; n = Math.floor(n / 26); }
  return out || 'A';
}

/**
 * Float and equation numbering, shared with the fragments a document parses
 * inside frames, columns and callouts.
 *
 * Those fragments go through parseLatexPreview again (see adoptFragment), and a
 * fresh parse starts every counter at zero — so two Beamer frames each holding
 * one figure both produced "Figure 1", and the numbering of everything after
 * them restarted too. One mutable object threaded through the child parse keeps
 * the whole document on a single sequence: the child continues where the parent
 * was, and the parent continues where the child ended.
 */
export interface PreviewCounters { figure: number; table: number; equation: number }

/** Parse a complete .tex document or a standalone included section. Never throws. */
export function parseLatexPreview(source: string, counters: PreviewCounters = { figure: 0, table: 0, equation: 0 }): PreviewDocument {
  const plain = maskLatexFalseBlocks(maskLatexComments(source));
  const beamerClass = /\\documentclass\s*(?:\[([^\]]*)\]\s*)?\{beamer\}/.exec(plain);
  // A `\begin{frame}` quoted inside verbatim or lstlisting is documentation
  // about Beamer, not a slide; an article that shows one must stay an article.
  const kind: PreviewDocument['kind'] = beamerClass || /\\begin\s*\{frame\}/.test(maskLatexLiteralRegions(plain))
    ? 'presentation'
    : 'article';
  // Overlay masking is Beamer syntax and belongs to decks only. In an ordinary
  // paper `<expr> ::= …` is BNF and `\alert<x>` is prose about a macro; blanking
  // either one deletes the author's own words.
  const masked = kind === 'presentation' ? maskBeamerOverlays(plain) : plain;
  const footnotes: PreviewFootnote[] = [];
  const approximated = new Set<string>();
  const references: Record<string, PreviewReference> = {};
  const baseContext: ParseContext = { footnotes, approximated, line: 1, offset: undefined };
  const metadata = titleMetadata(masked, baseContext);
  const aspectRatio: PreviewDocument['aspectRatio'] = /(?:^|,)\s*aspectratio\s*=\s*169\s*(?:,|$)/.test(beamerClass?.[1] ?? '')
    ? '16:9'
    : '4:3';

  const begin = /\\begin\s*\{document\}/.exec(masked);
  const bodyStart = begin ? begin.index + begin[0].length : 0;
  const endToken = /\\end\s*\{document\}/g;
  let bodyEnd = masked.length;
  for (let match = endToken.exec(masked); match; match = endToken.exec(masked)) bodyEnd = match.index;

  const starts = [0];
  for (let i = 0; i < masked.length; i++) if (masked[i] === '\n') starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid; }
    return lo + 1;
  };

  const lines: SourceLine[] = [];
  for (let at = bodyStart; at < bodyEnd;) {
    const newline = masked.indexOf('\n', at);
    const end = newline >= 0 && newline < bodyEnd ? newline : bodyEnd;
    lines.push({ start: at, end, text: masked.slice(at, end).replace(/\r$/, ''), number: lineOf(at) });
    at = end + 1;
  }
  const firstLineAtOrAfter = (offset: number): number => {
    let lo = 0, hi = lines.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid].start < offset) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const blocks: PreviewBlock[] = [];
  let section = 0, subsection = 0, subsubsection = 0;
  let frame = 0;
  let appendix = false;
  let titlePlaced = false;

  const register = (raw: string, number: string, kind: PreviewReference['kind']) => {
    for (const key of labelsIn(raw)) references[key] = { number, kind };
  };
  // Panels carry their own labels. Run after `register`, which claims every
  // label in the float: `\ref` to a subfigure should read 1a, not 1 like the
  // figure that contains it.
  const registerPanels = (raw: string, number: string, kind: PreviewReference['kind']) => {
    const opening = new RegExp(`\\\\begin\\s*\\{(?:${SUBFLOAT})\\*?\\}`, 'g');
    let panel = 0;
    for (let found = opening.exec(raw); found; found = opening.exec(raw)) {
      const inner = environmentAt(raw, found.index);
      if (!inner) continue;
      const letter = String.fromCharCode(97 + panel++);
      for (const key of labelsIn(raw.slice(inner.innerStart, inner.endStart))) {
        references[key] = { number: `${number}${letter}`, kind };
      }
      opening.lastIndex = Math.max(opening.lastIndex, inner.end);
    }
  };
  const addParagraph = (raw: string, line: number, align?: 'center', offset?: number) => {
    const content = parseTrimmedInline(raw, offset, baseContext, line);
    if (previewPlainText(content)) blocks.push({ type: 'paragraph', line, content, align });
  };

  const adoptFragment = (fragment: string, absoluteStart: number): PreviewBlock[] => {
    if (!fragment.trim()) return [];
    // The same counters object, so figures and tables inside a frame or a
    // callout continue this document's numbering instead of restarting at 1.
    const child = parseLatexPreview(fragment, counters);
    const footnoteOffset = footnotes.length;
    const lineDelta = lineOf(absoluteStart) - 1;
    for (const note of child.footnotes) {
      footnotes.push({
        ...note,
        number: note.number + footnoteOffset,
        line: note.line + lineDelta,
        content: shiftInlineNodes(note.content, absoluteStart, footnoteOffset),
      });
    }
    Object.assign(references, child.references);
    for (const approximation of child.approximated) approximated.add(approximation);
    return child.blocks.map((block) => shiftPreviewBlock(block, absoluteStart, lineDelta, footnoteOffset));
  };

  const parseEnvironment = (environment: ReturnType<typeof environmentAt>, line: number): PreviewBlock[] => {
    if (!environment) return [];
    const name = environment.name;
    const raw = masked.slice(environment.innerStart, environment.endStart);
    const lower = name.toLowerCase();

    const skipWhitespace = (value: string, start: number): number => {
      let cursor = start;
      while (/\s/.test(value[cursor] ?? '')) cursor++;
      return cursor;
    };
    const skipOverlay = (value: string, start: number): { cursor: number; found: boolean } => {
      const cursor = skipWhitespace(value, start);
      if (value[cursor] !== '<') return { cursor, found: false };
      const end = value.indexOf('>', cursor + 1);
      return { cursor: end >= 0 ? end + 1 : value.length, found: true };
    };

    if (lower === 'frame') {
      let cursor = 0;
      let overlayHeader = false;
      const optionValues: string[] = [];
      // Beamer permits overlay and option groups in either order before the
      // frame title: \begin{frame}<2->[fragile]{Title}.
      for (;;) {
        const overlay = skipOverlay(raw, cursor);
        cursor = overlay.cursor;
        overlayHeader ||= overlay.found;
        const optionAt = skipWhitespace(raw, cursor);
        if (raw[optionAt] !== '[') { cursor = optionAt; break; }
        const option = readGroup(raw, optionAt);
        if (!option) break;
        optionValues.push(option.value);
        cursor = option.end;
      }

      let title: InlineNode[] = [];
      let subtitle: InlineNode[] = [];
      cursor = skipWhitespace(raw, cursor);
      if (raw[cursor] === '{') {
        const group = readGroup(raw, cursor);
        if (group) {
          title = parseInline(group.value, {
            ...baseContext,
            line: lineOf(environment.innerStart + group.start + 1),
            offset: environment.innerStart + group.start + 1,
          });
          cursor = group.end;
        }
        cursor = skipWhitespace(raw, cursor);
        if (raw[cursor] === '{') {
          const group = readGroup(raw, cursor);
          if (group) {
            subtitle = parseInline(group.value, {
              ...baseContext,
              line: lineOf(environment.innerStart + group.start + 1),
              offset: environment.innerStart + group.start + 1,
            });
            cursor = group.end;
          }
        }
      }

      const bodyStart = environment.innerStart + cursor;
      const body = raw.slice(cursor);
      const titleMacro = findCommand(body, 'frametitle');
      const subtitleMacro = findCommand(body, 'framesubtitle');
      if (!title.length && titleMacro?.args[0]) {
        title = parseInline(titleMacro.args[0].value, {
          ...baseContext,
          line: lineOf(bodyStart + titleMacro.args[0].start + 1),
          offset: bodyStart + titleMacro.args[0].start + 1,
        });
      }
      if (!subtitle.length && subtitleMacro?.args[0]) {
        subtitle = parseInline(subtitleMacro.args[0].value, {
          ...baseContext,
          line: lineOf(bodyStart + subtitleMacro.args[0].start + 1),
          offset: bodyStart + subtitleMacro.args[0].start + 1,
        });
      }

      const children = adoptFragment(body, bodyStart);
      const titlePage = /\\(?:titlepage|maketitle)\b/.test(body);
      if (titlePage && metadata && !children.some((block) => block.type === 'title')) {
        children.unshift({ type: 'title', line: metadata.line, title: metadata.title, author: metadata.author, date: metadata.date });
        titlePlaced = true;
      }
      const originalRaw = source.slice(environment.innerStart, environment.endStart);
      const overlays = overlayHeader || /\\(?:pause|only|uncover|visible|invisible|onslide|alt|temporal)\b|\\item\s*</.test(originalRaw);
      return [{
        type: 'frame',
        line,
        number: ++frame,
        title,
        subtitle,
        blocks: children,
        plain: optionValues.some((value) => /(?:^|,)\s*plain\s*(?:,|$)/.test(value)),
        overlays,
      }];
    }

    if (lower === 'columns') {
      const columns: PreviewBlock[][] = [];
      const columnBegin = /\\begin\s*\{column\}/g;
      for (let found = columnBegin.exec(raw); found; found = columnBegin.exec(raw)) {
        const column = environmentAt(raw, found.index);
        if (!column) continue;
        let cursor = skipWhitespace(raw, column.innerStart);
        if (raw[cursor] === '[') cursor = readGroup(raw, cursor)?.end ?? cursor;
        cursor = skipWhitespace(raw, cursor);
        // The mandatory width is layout, not visible column content.
        if (raw[cursor] === '{') cursor = readGroup(raw, cursor)?.end ?? cursor;
        const absoluteStart = environment.innerStart + cursor;
        columns.push(adoptFragment(raw.slice(cursor, column.endStart), absoluteStart));
        columnBegin.lastIndex = Math.max(columnBegin.lastIndex, column.end);
      }
      // Also support the compact \column{.5\textwidth} form.
      if (!columns.length) {
        const columnMacro = [...raw.matchAll(/\\column\b/g)];
        for (let index = 0; index < columnMacro.length; index++) {
          const macro = readMacro(raw, columnMacro[index].index!);
          if (!macro) continue;
          const start = macro.end;
          const end = columnMacro[index + 1]?.index ?? raw.length;
          columns.push(adoptFragment(raw.slice(start, end), environment.innerStart + start));
        }
      }
      if (columns.length) return [{ type: 'columns', line, columns }];
    }

    const callout = /(?:block|definition|theorem|lemma|proposition|corollary|example|proof)$/.test(lower) ||
      /^(?:keyresult|checkblock|pairblock|definitionblock|exampleblock|alertblock)$/.test(lower);
    if (callout) {
      let cursor = skipWhitespace(raw, 0);
      const overlay = skipOverlay(raw, cursor);
      cursor = overlay.cursor;
      cursor = skipWhitespace(raw, cursor);
      let heading: Group | null = null;
      if (raw[cursor] === '[' || (/(?:block)$/.test(lower) || lower === 'keyresult') && raw[cursor] === '{') {
        heading = readGroup(raw, cursor);
        if (heading) cursor = heading.end;
      }
      const title = heading ? parseInline(heading.value, {
        ...baseContext,
        line: lineOf(environment.innerStart + heading.start + 1),
        offset: environment.innerStart + heading.start + 1,
      }) : [];
      const tone: 'neutral' | 'accent' | 'success' = /alert|warning|danger/.test(lower)
        ? 'accent'
        : /example|check|keyresult/.test(lower) ? 'success' : 'neutral';
      return [{
        type: 'callout',
        line,
        title,
        tone,
        blocks: adoptFragment(raw.slice(cursor), environment.innerStart + cursor),
      }];
    }

    if (/^(?:equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|displaymath|math)$/.test(lower)) {
      const numbered = !lower.endsWith('*') && lower !== 'displaymath' && lower !== 'math';
      const number = numbered ? String(++counters.equation) : undefined;
      if (number) register(raw, number, 'equation');
      const tex = raw.replace(/\\label\s*\{[^{}]*\}/g, '').replace(/\\(?:nonumber|notag)\b/g, '').trim();
      return tex ? [{ type: 'math', line, tex, number }] : [];
    }

    if (lower === 'figure' || lower === 'figure*') {
      const number = String(++counters.figure);
      const caption = findFloatCaption(raw);
      const assets = [...raw.matchAll(/\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g)].map((match) => match[1].trim());
      register(raw, number, 'figure');
      registerPanels(raw, number, 'figure');
      return [{
        type: 'figure', line, number, assets,
        caption: caption?.args[0] ? parseInline(caption.args[0].value, {
          ...baseContext,
          line,
          offset: environment.innerStart + caption.args[0].start + 1,
        }) : [],
      }];
    }

    if (lower === 'table' || lower === 'table*') {
      const number = String(++counters.table);
      const caption = findFloatCaption(raw);
      register(raw, number, 'table');
      registerPanels(raw, number, 'table');
      const tabularMatch = /\\begin\s*\{(tabular\*?|tabularx|longtable)\}/.exec(raw);
      const rows: PreviewTableRow[] = [];
      if (tabularMatch) {
        const tabular = environmentAt(raw, tabularMatch.index);
        if (tabular) {
          let contentStart = tabular.innerStart;
          // Column definitions (and tabularx's width) are layout, not content.
          const groupsToSkip = tabular.name === 'tabularx' || tabular.name === 'tabular*' ? 2 : 1;
          for (let skipped = 0; skipped < groupsToSkip; skipped++) {
            while (/\s/.test(raw[contentStart] ?? '')) contentStart++;
            const group = readGroup(raw, contentStart);
            if (group) contentStart = group.end;
          }
          const tabularRaw = raw.slice(contentStart, tabular.endStart);
          const midrule = tabularRaw.indexOf('\\midrule');
          for (const row of splitAtTopLevel(tabularRaw, 'row')) {
            const rowValue = maskTableNoise(row.value);
            if (!trimTableNoise(rowValue)) continue;
            const cells: PreviewTableCell[] = splitAtTopLevel(rowValue, 'cell').map((cell) => {
              const cellStart = environment.innerStart + contentStart + row.start + cell.start;
              const leading = cell.value.length - cell.value.trimStart().length;
              const macro = readMacro(cell.value, leading);
              const multi = macro?.name === 'multicolumn' && macro.args[2] ? macro : null;
              const content = multi
                ? parseInline(multi.args[2].value, {
                    ...baseContext,
                    line: lineOf(cellStart + multi.args[2].start + 1),
                    offset: cellStart + multi.args[2].start + 1,
                  })
                : parseTrimmedInline(cell.value, cellStart, baseContext, lineOf(cellStart));
              return {
                content,
                ...(multi ? { colSpan: Math.max(1, Number(multi.args[0]?.value ?? 1)) } : {}),
              };
            });
            if (cells.some((cell) => previewPlainText(cell.content))) rows.push({ cells, header: midrule >= 0 && row.start < midrule });
          }
        }
      }
      return [{
        type: 'table', line, number, rows,
        caption: caption?.args[0] ? parseInline(caption.args[0].value, {
          ...baseContext,
          line,
          offset: environment.innerStart + caption.args[0].start + 1,
        }) : [],
      }];
    }

    if (lower === 'itemize' || lower === 'enumerate' || lower === 'description') {
      const itemRe = /\\item\b/g;
      const found = [...raw.matchAll(itemRe)];
      const items: Array<{ label?: InlineNode[]; content: InlineNode[] }> = [];
      for (let index = 0; index < found.length; index++) {
        let start = found[index].index! + found[index][0].length;
        const end = found[index + 1]?.index ?? raw.length;
        while (/\s/.test(raw[start] ?? '')) start++;
        let label: InlineNode[] | undefined;
        if (raw[start] === '[') {
          const group = readGroup(raw, start);
          // Only a bracket that closes is a description label. `\item [0,1) is
          // the range` is prose, and treating its `[` as a label consumed the
          // rest of the list — the item then had no content and vanished.
          if (group && closedGroup(raw, group)) {
            label = parseInline(group.value, {
              ...baseContext,
              line: lineOf(environment.innerStart + start),
              offset: environment.innerStart + group.start + 1,
            });
            start = group.end;
          }
        }
        const itemRaw = raw.slice(start, end);
        const itemLine = lineOf(environment.innerStart + start);
        const content = parseTrimmedInline(itemRaw, environment.innerStart + start, baseContext, itemLine);
        if (previewPlainText(content)) items.push({ label, content });
      }
      return items.length ? [{ type: 'list', line, ordered: lower === 'enumerate', description: lower === 'description', items }] : [];
    }

    if (lower === 'abstract') {
      const heading: PreviewBlock = { type: 'heading', line, level: 2, content: [{ type: 'text', text: 'Abstract' }] };
      return [heading, ...paragraphParts(raw, environment.innerStart, baseContext, lineOf)];
    }
    if (lower === 'quote' || lower === 'quotation' || lower === 'verse') {
      return [{ type: 'quote', line, content: parseTrimmedInline(raw, environment.innerStart, baseContext, line) }];
    }
    if (lower === 'verbatim' || lower === 'lstlisting' || lower === 'minted') {
      return [{ type: 'code', line, content: raw.trim(), language: lower === 'minted' ? 'code' : undefined }];
    }
    // `comment` is the package spelling of `\iffalse`: parked text that the PDF
    // never shows. Live showed it as ordinary editable prose, so a draft
    // paragraph the author had deliberately shelved reappeared in the paper.
    if (lower === 'comment') return [];
    if (lower === 'tikzpicture' || lower === 'picture') {
      approximated.add(`environment ${name}`);
      return [{ type: 'notice', line, label: 'Diagram', detail: 'Rendered in the exact PDF view' }];
    }
    if (lower === 'center' || lower === 'flushleft' || lower === 'flushright') {
      return paragraphParts(raw, environment.innerStart, baseContext, lineOf, lower === 'center' ? 'center' : undefined);
    }
    if (lower === 'thebibliography') {
      return [{ type: 'notice', line, label: 'References', detail: 'Citation formatting is shown in the exact PDF view' }];
    }

    approximated.add(`environment ${name}`);
    return paragraphParts(raw, environment.innerStart, baseContext, lineOf);
  };

  // An image on a line of its own is a block. An image with a sentence beside it
  // — `\includegraphics{logo} is our logo, and…` — is part of that sentence, and
  // breaking the paragraph there used to drop the rest of the line from Live.
  const imageOnlyLine = /^(?:\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}\s*)+$/;
  const isBlockStart = (trimmed: string): boolean =>
    /^\\(?:section|subsection|subsubsection|paragraph)\*?\b/.test(trimmed) ||
    /^\\begin\s*\{/.test(trimmed) || /^\\(?:maketitle|appendix|input|include|bibliography)\b/.test(trimmed) ||
    imageOnlyLine.test(trimmed) ||
    /^\\(?:title|author|date|thanks)\b/.test(trimmed) || trimmed.startsWith('\\[') || trimmed.startsWith('$$');

  for (let i = 0; i < lines.length;) {
    const sourceLine = lines[i];
    const leading = sourceLine.text.length - sourceLine.text.trimStart().length;
    const trimmed = sourceLine.text.trim();
    const absolute = sourceLine.start + leading;
    if (!trimmed) { i++; continue; }

    if (/^\\appendix\b/.test(trimmed)) { appendix = true; section = subsection = subsubsection = 0; i++; continue; }

    if (/^\\maketitle\b/.test(trimmed)) {
      if (metadata) blocks.push({ type: 'title', line: metadata.line, title: metadata.title, author: metadata.author, date: metadata.date });
      titlePlaced = true;
      i++;
      continue;
    }

    const headingHead = /^\\(section|subsection|subsubsection|paragraph)(\*)?\b/.exec(trimmed);
    if (headingHead) {
      const macro = readMacro(masked, absolute);
      if (macro?.args[0]) {
        const level = ({ section: 1, subsection: 2, subsubsection: 3, paragraph: 4 } as const)[headingHead[1] as 'section'];
        let number: string | undefined;
        if (!macro.starred && level < 4) {
          if (level === 1) { section++; subsection = subsubsection = 0; number = appendix ? letterNumber(section) : String(section); }
          else if (level === 2) { subsection++; subsubsection = 0; number = `${appendix ? letterNumber(section) : section}.${subsection}`; }
          else { subsubsection++; number = `${appendix ? letterNumber(section) : section}.${subsection}.${subsubsection}`; }
        }
        const endLineIndex = Math.max(i, firstLineAtOrAfter(macro.args[0].end) - 1);
        const tailEnd = lines[endLineIndex]?.end ?? macro.args[0].end;
        const tail = masked.slice(macro.args[0].end, tailEnd);
        if (number) register(macro.args[0].value + tail, number, 'section');
        blocks.push({
          type: 'heading',
          line: sourceLine.number,
          level,
          number,
          content: parseInline(macro.args[0].value, {
            ...baseContext,
            line: sourceLine.number,
            offset: macro.args[0].start + 1,
          }),
        });
        // Keep the same-line body after `\paragraph{Heading}` mapped to its
        // exact source. `parseInline` already hides `\label{...}` safely, so
        // pre-stripping labels here would only destroy edit coordinates.
        if (tail.trim()) addParagraph(tail, lineOf(macro.args[0].end), undefined, macro.args[0].end);
        i = endLineIndex + 1;
        continue;
      }
    }

    if (/^\\begin\s*\{/.test(trimmed)) {
      const environment = environmentAt(masked, absolute);
      if (environment) {
        blocks.push(...parseEnvironment(environment, sourceLine.number));
        i = firstLineAtOrAfter(environment.end);
        continue;
      }
    }

    if (trimmed.startsWith('\\[') || trimmed.startsWith('$$')) {
      const open = trimmed.startsWith('\\[') ? '\\[' : '$$';
      const close = open === '\\[' ? '\\]' : '$$';
      const start = absolute + open.length;
      const end = masked.indexOf(close, start);
      const finish = end >= 0 ? end : sourceLine.end;
      const tex = masked.slice(start, finish).trim();
      if (tex) blocks.push({ type: 'math', line: sourceLine.number, tex });
      i = firstLineAtOrAfter(finish + close.length);
      continue;
    }

    if (/^\\includegraphics\b/.test(trimmed)) {
      const assets: string[] = [];
      let searchAt = absolute;
      for (;;) {
        const graphic = findCommand(masked, 'includegraphics', searchAt);
        if (!graphic || graphic.start >= sourceLine.end) break;
        if (graphic.args[0]?.value.trim()) assets.push(graphic.args[0].value.trim());
        searchAt = Math.max(graphic.end, graphic.start + 1);
      }
      if (assets.length) blocks.push({ type: 'image', line: sourceLine.number, assets });
      i = Math.max(i + 1, firstLineAtOrAfter(searchAt));
      // An image is often introduced by the sentence sharing its line. That tail
      // is prose and belongs in Live; without this it was simply never rendered.
      const tailEnd = lines[i - 1]?.end ?? sourceLine.end;
      if (searchAt < tailEnd) {
        const tail = masked.slice(searchAt, tailEnd);
        if (tail.trim()) addParagraph(tail, lineOf(searchAt), undefined, searchAt);
      }
      continue;
    }

    const includeHead = /^\\(?:input|include)\b/.exec(trimmed);
    if (includeHead) {
      const macro = readMacro(masked, absolute);
      if (macro?.args[0]) blocks.push({ type: 'include', line: sourceLine.number, path: macro.args[0].value.trim() });
      i = macro ? Math.max(i + 1, firstLineAtOrAfter(macro.end)) : i + 1;
      continue;
    }

    const metadataHead = /^\\(?:title|author|date|thanks)\b/.test(trimmed);
    if (metadataHead) {
      const macro = readMacro(masked, absolute);
      i = macro ? Math.max(i + 1, firstLineAtOrAfter(macro.end)) : i + 1;
      continue;
    }

    if (/^\\bibliography\b/.test(trimmed)) {
      blocks.push({ type: 'notice', line: sourceLine.number, label: 'References', detail: 'Citation formatting is shown in the exact PDF view' });
      i++;
      continue;
    }

    const paragraphStart = i;
    while (i < lines.length) {
      const candidate = lines[i].text.trim();
      if (!candidate || (i > paragraphStart && isBlockStart(candidate))) break;
      i++;
    }
    const paragraphEnd = i > paragraphStart ? lines[i - 1].end : lines[paragraphStart].end;
    const raw = masked.slice(lines[paragraphStart].start, paragraphEnd);
    if (raw.trim()) addParagraph(raw, lines[paragraphStart].number, undefined, lines[paragraphStart].start);
    if (i === paragraphStart) i++;
  }

  if (metadata && !titlePlaced && begin && kind === 'article') {
    blocks.unshift({ type: 'title', line: metadata.line, title: metadata.title, author: metadata.author, date: metadata.date });
  }

  const renderedTextForBlock = (block: PreviewBlock): string[] => {
    if (block.type === 'title') return [previewPlainText(block.title), previewPlainText(block.author), previewPlainText(block.date)];
    if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote') return [previewPlainText(block.content)];
    if (block.type === 'list') return block.items.flatMap((item) => [previewPlainText(item.label ?? []), previewPlainText(item.content)]);
    if (block.type === 'figure') return [previewPlainText(block.caption)];
    if (block.type === 'table') return [previewPlainText(block.caption), ...block.rows.flatMap((row) => row.cells.map((cell) => previewPlainText(cell.content)))];
    if (block.type === 'frame') return [
      previewPlainText(block.title),
      previewPlainText(block.subtitle),
      ...block.blocks.flatMap(renderedTextForBlock),
    ];
    if (block.type === 'columns') return block.columns.flatMap((column) => column.flatMap(renderedTextForBlock));
    if (block.type === 'callout') return [previewPlainText(block.title), ...block.blocks.flatMap(renderedTextForBlock)];
    if (block.type === 'code') return [block.content];
    if (block.type === 'notice') return [block.label, block.detail ?? ''];
    return [];
  };
  const renderedText = blocks.flatMap(renderedTextForBlock);
  renderedText.push(...footnotes.map((footnote) => previewPlainText(footnote.content)));
  const wordCount = renderedText.join(' ').split(/\s+/).filter(Boolean).length;

  return { kind, aspectRatio, blocks, footnotes, references, approximated: [...approximated].sort(), wordCount };
}
