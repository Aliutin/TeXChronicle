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
  | (LocatedBlock & { type: 'notice'; label: string; detail?: string })
  | (LocatedBlock & { type: 'include'; path: string });

export interface PreviewDocument {
  blocks: PreviewBlock[];
  footnotes: PreviewFootnote[];
  references: Record<string, PreviewReference>;
  approximated: string[];
  wordCount: number;
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
]);

const DROP_WITH_ARGS = new Set([
  'label', 'index', 'thispagestyle', 'pagestyle', 'vspace', 'hspace', 'vskip', 'hskip',
  'setlength', 'addtolength', 'setcounter', 'addtocounter', 'renewcommand', 'newcommand',
  'providecommand', 'DeclareRobustCommand', 'fontsize', 'fontencoding', 'hypertarget',
  'phantomsection', 'bibliographystyle', 'bibliography', 'includegraphics', 'cline', 'begin', 'end',
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

export interface PreviewSourceLocation { file: string; line: number }
export interface ExpandedPreviewSource { text: string; locations: PreviewSourceLocation[] }

export function sourceWithPreviewLocations(file: string, source: string): ExpandedPreviewSource {
  const lines = source.split(/\r?\n/);
  return { text: lines.join('\n'), locations: lines.map((_, index) => ({ file, line: index + 1 })) };
}

export function resolveLatexInclude(parent: string, requested: string): string | null {
  let target = requested.trim().replace(/\\/g, '/');
  if (!target || /^(?:[a-z]+:|\/)/i.test(target)) return null;
  if (!/\.[A-Za-z0-9]+$/.test(target)) target += '.tex';
  if (!/\.tex$/i.test(target)) return null;
  const parentParts = parent.replace(/\\/g, '/').split('/').slice(0, -1);
  const parts = [...parentParts, ...target.split('/')];
  const clean: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!clean.length) return null; clean.pop(); }
    else clean.push(part);
  }
  return clean.join('/');
}

/** Expand ordinary line-level \input/\include calls while retaining a map back
 * to every original file and line. Preamble inputs (fonts, generated maps) are
 * deliberately left to TeX. The loader keeps this function browser-agnostic. */
export async function expandLatexIncludes(
  file: string,
  source: string,
  load: (path: string, signal: AbortSignal) => Promise<string | null>,
  signal: AbortSignal,
  visited = new Set<string>([file]),
  depth = 0,
): Promise<ExpandedPreviewSource> {
  if (depth >= 8) return sourceWithPreviewLocations(file, source);
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  const locations: PreviewSourceLocation[] = [];
  const hasDocument = /\\begin\s*\{document\}/.test(maskLatexComments(source));
  let inDocument = !hasDocument;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const visible = maskLatexComments(line);
    if (/\\begin\s*\{document\}/.test(visible)) inDocument = true;
    const include = inDocument ? /^\s*\\(?:input|include)\s*\{([^{}]+)\}\s*$/.exec(visible) : null;
    const child = include ? resolveLatexInclude(file, include[1]) : null;
    if (child && !visited.has(child)) {
      const childSource = await load(child, signal).catch((error) => {
        if (signal.aborted) throw error;
        return null;
      });
      if (childSource !== null) {
        const expanded = await expandLatexIncludes(child, childSource, load, signal, new Set(visited).add(child), depth + 1);
        output.push(...expanded.text.split('\n'));
        locations.push(...expanded.locations);
        continue;
      }
    }
    output.push(line);
    locations.push({ file, line: index + 1 });
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
    previous.source.boundaries.push(...node.source.boundaries.slice(1));
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
      i = macro.headEnd;
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
    if (['mbox', 'makebox', 'parbox', 'raisebox', 'multicolumn', 'multirow'].includes(macro.name) && macro.args.length) {
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
      i = macro.headEnd;
      continue;
    }
    if (DROP_WITH_ARGS.has(macro.name)) {
      i = macro.args.length ? macro.args[macro.args.length - 1].end : macro.headEnd;
      continue;
    }

    // Project-local presentation macros usually wrap visible text. Preserve
    // their first argument instead of failing the whole preview.
    if (macro.args[0]) {
      context.approximated.add(`\\${macro.name}`);
      nodes.push(...childrenFor(macro.args[0], context));
      i = macro.args[0].end;
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

function trimTableNoise(text: string): string {
  return text
    .replace(/\\(?:toprule|midrule|bottomrule|hline|cline\s*\{[^{}]*\}|addlinespace(?:\s*\[[^\]]*\])?)/g, ' ')
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

/** Parse a complete .tex document or a standalone included section. Never throws. */
export function parseLatexPreview(source: string): PreviewDocument {
  const masked = maskLatexComments(source);
  const footnotes: PreviewFootnote[] = [];
  const approximated = new Set<string>();
  const references: Record<string, PreviewReference> = {};
  const baseContext: ParseContext = { footnotes, approximated, line: 1, offset: undefined };
  const metadata = titleMetadata(masked, baseContext);

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
  let figure = 0, table = 0, equation = 0;
  let appendix = false;
  let titlePlaced = false;

  const register = (raw: string, number: string, kind: PreviewReference['kind']) => {
    for (const key of labelsIn(raw)) references[key] = { number, kind };
  };
  const addParagraph = (raw: string, line: number, align?: 'center', offset?: number) => {
    const content = parseTrimmedInline(raw, offset, baseContext, line);
    if (previewPlainText(content)) blocks.push({ type: 'paragraph', line, content, align });
  };

  const parseEnvironment = (environment: ReturnType<typeof environmentAt>, line: number): PreviewBlock[] => {
    if (!environment) return [];
    const name = environment.name;
    const raw = masked.slice(environment.innerStart, environment.endStart);
    const lower = name.toLowerCase();

    if (/^(?:equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|displaymath|math)$/.test(lower)) {
      const numbered = !lower.endsWith('*') && lower !== 'displaymath' && lower !== 'math';
      const number = numbered ? String(++equation) : undefined;
      if (number) register(raw, number, 'equation');
      const tex = raw.replace(/\\label\s*\{[^{}]*\}/g, '').replace(/\\(?:nonumber|notag)\b/g, '').trim();
      return tex ? [{ type: 'math', line, tex, number }] : [];
    }

    if (lower === 'figure' || lower === 'figure*') {
      const number = String(++figure);
      const caption = findCommand(raw, 'caption');
      const assets = [...raw.matchAll(/\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g)].map((match) => match[1].trim());
      register(raw, number, 'figure');
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
      const number = String(++table);
      const caption = findCommand(raw, 'caption');
      register(raw, number, 'table');
      const tabularMatch = /\\begin\s*\{(tabular\*?|tabularx|longtable)\}/.exec(raw);
      const rows: PreviewTableRow[] = [];
      if (tabularMatch) {
        const tabular = environmentAt(raw, tabularMatch.index);
        if (tabular) {
          let contentStart = tabular.innerStart;
          // Column definitions (and tabularx's width) are layout, not content.
          const groupsToSkip = tabular.name === 'tabularx' ? 2 : 1;
          for (let skipped = 0; skipped < groupsToSkip; skipped++) {
            while (/\s/.test(raw[contentStart] ?? '')) contentStart++;
            const group = readGroup(raw, contentStart);
            if (group) contentStart = group.end;
          }
          const tabularRaw = raw.slice(contentStart, tabular.endStart);
          const midrule = tabularRaw.indexOf('\\midrule');
          for (const row of splitAtTopLevel(tabularRaw, 'row')) {
            if (!trimTableNoise(row.value)) continue;
            const cells: PreviewTableCell[] = splitAtTopLevel(row.value, 'cell').map((cell) => {
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
          if (group) {
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

  const isBlockStart = (trimmed: string): boolean =>
    /^\\(?:section|subsection|subsubsection|paragraph)\*?\b/.test(trimmed) ||
    /^\\begin\s*\{/.test(trimmed) || /^\\(?:maketitle|appendix|input|include|bibliography)\b/.test(trimmed) ||
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

  if (metadata && !titlePlaced && begin) blocks.unshift({ type: 'title', line: metadata.line, title: metadata.title, author: metadata.author, date: metadata.date });

  const renderedText = blocks.flatMap((block): string[] => {
    if (block.type === 'title') return [previewPlainText(block.title), previewPlainText(block.author), previewPlainText(block.date)];
    if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote') return [previewPlainText(block.content)];
    if (block.type === 'list') return block.items.flatMap((item) => [previewPlainText(item.label ?? []), previewPlainText(item.content)]);
    if (block.type === 'figure') return [previewPlainText(block.caption)];
    if (block.type === 'table') return [previewPlainText(block.caption), ...block.rows.flatMap((row) => row.cells.map((cell) => previewPlainText(cell.content)))];
    if (block.type === 'code') return [block.content];
    if (block.type === 'notice') return [block.label, block.detail ?? ''];
    return [];
  });
  renderedText.push(...footnotes.map((footnote) => previewPlainText(footnote.content)));
  const wordCount = renderedText.join(' ').split(/\s+/).filter(Boolean).length;

  return { blocks, footnotes, references, approximated: [...approximated].sort(), wordCount };
}
