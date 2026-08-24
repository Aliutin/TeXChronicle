import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import {
  contentEditableParagraphDraft,
  expandLatexIncludes,
  parseLatexPreview,
  previewTextChange,
  previewPlainText,
  sourceWithPreviewLocations,
  type InlineNode,
  type ExpandedPreviewSource,
  type PreviewSourceLocation,
  type PreviewBlock,
  type PreviewDocument,
  type PreviewReference,
  type PreviewIncludeFile,
  type PreviewTextSource,
  type PreviewTextChange,
} from '../latexPreview';
import { LiveFigureAsset, type AssetSelection } from './AssetPreview';

export interface LiveSourceEdit {
  file: string;
  from: { line: number; column: number };
  to: { line: number; column: number };
  expected: string;
  insert: string;
}

interface EditingContextValue {
  canEdit: (source: PreviewTextSource) => boolean;
  resolve: (change: PreviewTextChange) => LiveSourceEdit | null;
  apply: (edit: LiveSourceEdit) => boolean;
  fail: (message: string) => void;
}

const EditingContext = createContext<EditingContextValue | null>(null);

function mapLocations(document: PreviewDocument, locations: PreviewSourceLocation[], fallbackFile: string): PreviewDocument {
  const at = (line: number): PreviewSourceLocation => locations[Math.max(0, line - 1)] ?? { file: fallbackFile, line };
  return {
    ...document,
    blocks: document.blocks.map((block) => ({ ...block, ...at(block.line) })),
    footnotes: document.footnotes.map((footnote) => ({ ...footnote, line: at(footnote.line).line })),
  };
}

function sourceLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low;
}

function sourceRangeEditable(source: PreviewTextSource, expanded: ExpandedPreviewSource, starts: number[]): boolean {
  const startIndex = lineIndexAt(starts, source.from);
  const endIndex = lineIndexAt(starts, source.to);
  for (let index = startIndex; index <= endIndex; index++) {
    if (expanded.locations[index]?.editable === false) return false;
  }
  return true;
}

function resolveSourceEdit(
  change: PreviewTextChange,
  expanded: ExpandedPreviewSource,
  starts: number[],
  fallbackFile: string,
): LiveSourceEdit | null {
  if (change.from < 0 || change.to < change.from || change.to > expanded.text.length) return null;
  const startIndex = lineIndexAt(starts, change.from);
  const endIndex = lineIndexAt(starts, change.to);
  const startLocation = expanded.locations[startIndex] ?? { file: fallbackFile, line: startIndex + 1 };
  const endLocation = expanded.locations[endIndex] ?? { file: fallbackFile, line: endIndex + 1 };
  if (startLocation.file !== endLocation.file) return null;

  // A text leaf may cover several physical source lines, but never an include
  // boundary or a non-contiguous mapping inside another file.
  for (let index = startIndex; index <= endIndex; index++) {
    const location = expanded.locations[index] ?? { file: fallbackFile, line: index + 1 };
    if (
      location.file !== startLocation.file ||
      location.line !== startLocation.line + index - startIndex
    ) return null;
  }

  return {
    file: startLocation.file,
    from: { line: startLocation.line, column: change.from - starts[startIndex] },
    to: { line: endLocation.line, column: change.to - starts[endIndex] },
    expected: change.expected,
    insert: change.insert,
  };
}

function safeHref(href: string): string | undefined {
  const value = href.trim();
  if (/^(?:https?:|mailto:)/i.test(value)) return value;
  if (/^www\./i.test(value)) return `https://${value}`;
  return undefined;
}

function referenceText(node: Extract<InlineNode, { type: 'ref' }>, reference?: PreviewReference): string {
  if (!reference) return node.key.replace(/^(?:sec|fig|tab|eq|app):/i, '').replace(/[-_:]+/g, ' ');
  if (node.mode === 'eqref') return `(${reference.number})`;
  if (/^(?:autoref|cref|Cref)$/.test(node.mode)) {
    const label = reference.kind === 'other' ? '' : reference.kind;
    const word = node.mode === 'Cref' && label ? label[0].toUpperCase() + label.slice(1) : label;
    return `${word ? `${word} ` : ''}${reference.number}`;
  }
  return reference.number;
}

function MathView({ tex, display = false }: { tex: string; display?: boolean }) {
  const html = useMemo(() => {
    try { return katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, output: 'html' }); }
    catch { return ''; }
  }, [tex, display]);
  if (!html) return <code className="live-math-error">{tex}</code>;
  return <span className={display ? 'live-math-display' : 'live-math'} dangerouslySetInnerHTML={{ __html: html }} />;
}

function insertAtSelection(root: HTMLElement, text: string): boolean {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return false;
  range.deleteContents();
  const inserted = document.createTextNode(text);
  range.insertNode(inserted);
  range.setStartAfter(inserted);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function EditableText({ node }: { node: Extract<InlineNode, { type: 'text' }> }) {
  const editing = useContext(EditingContext);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draft = useRef(node.text);
  const lastCommitted = useRef(node.text);
  const structuralDraft = useRef(false);
  const editable = Boolean(node.source && editing && editing.canEdit(node.source));

  const commit = useCallback((draftValue: string) => {
    const value = structuralDraft.current ? contentEditableParagraphDraft(draftValue) : draftValue;
    if (!node.source || !editing || value === node.text || value === lastCommitted.current) return;
    const change = previewTextChange(node.source, node.text, value);
    const resolved = change ? editing.resolve(change) : null;
    if (resolved && editing.apply(resolved)) {
      lastCommitted.current = value;
      structuralDraft.current = false;
      return;
    }
    draft.current = node.text;
    lastCommitted.current = node.text;
    structuralDraft.current = false;
    if (ref.current) ref.current.textContent = node.text;
    editing.fail('That text no longer matches the source. The preview was refreshed; please retry the edit.');
  }, [editing, node.source, node.text]);

  const schedule = useCallback((value: string) => {
    draft.current = value;
    if (timer.current) clearTimeout(timer.current);
    // A paragraph split changes the document tree and therefore the focused
    // node. Keep the multi-paragraph draft local until blur, then apply it once
    // instead of reparsing underneath the caret halfway through the operation.
    if (structuralDraft.current || /[\r\n]/.test(value)) {
      structuralDraft.current = true;
      timer.current = null;
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      commit(value);
    }, 250);
  }, [commit]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (document.activeElement !== element || node.text === draft.current) {
      draft.current = node.text;
      lastCommitted.current = node.text;
      structuralDraft.current = false;
      if (element.textContent !== node.text) element.textContent = node.text;
    }
  }, [node.text]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (!editable) return node.text;
  return (
    <span
      ref={ref}
      className="live-editable-text"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      role="textbox"
      aria-label="Editable LaTeX prose"
      data-source-from={node.source?.from}
      onInput={(event) => schedule(event.currentTarget.textContent ?? '')}
      onBlur={(event) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        commit(event.currentTarget.textContent ?? '');
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLSpanElement>) => {
        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (!insertAtSelection(event.currentTarget, '\n\n')) return;
        schedule(event.currentTarget.textContent ?? '');
      }}
    />
  );
}

function InlineView({ nodes, document }: { nodes: InlineNode[]; document: PreviewDocument }): ReactNode {
  return nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    if (node.type === 'text') return <EditableText key={key} node={node} />;
    if (node.type === 'math') return <span key={key} contentEditable={false} className="live-atom"><MathView tex={node.tex} /></span>;
    if (node.type === 'break') return <br key={key} contentEditable={false} />;
    if (node.type === 'cite') {
      const text = node.mode === 'citet' ? node.keys : `[${node.keys}]`;
      return <span key={key} contentEditable={false} className="live-cite live-atom" title={`Citation keys: ${node.keys}. Edit exact source in Code.`}>{text}</span>;
    }
    if (node.type === 'ref') {
      return <span key={key} contentEditable={false} className="live-ref live-atom" title={`${node.key}. Edit exact source in Code.`}>{referenceText(node, document.references[node.key])}</span>;
    }
    if (node.type === 'footnote') {
      const footnote = document.footnotes.find((item) => item.number === node.number);
      return (
        <sup key={key} contentEditable={false} className="live-footnote-ref live-atom">
          <a href={`#live-footnote-${node.number}`} title={footnote ? previewPlainText(footnote.content) : 'Footnote'}>{node.number}</a>
        </sup>
      );
    }
    if (node.type === 'link') {
      const href = safeHref(node.href);
      return <span key={key} className={href ? 'live-link' : undefined} title={href ? `${href} · edit the label here; open the URL from Code` : undefined}><InlineView nodes={node.children} document={document} /></span>;
    }
    const content = <InlineView nodes={node.children} document={document} />;
    if (node.type === 'strong') return <strong key={key}>{content}</strong>;
    if (node.type === 'em') return <em key={key}>{content}</em>;
    if (node.type === 'code') return <code key={key} className="live-inline-code">{content}</code>;
    if (node.type === 'underline') return <u key={key}>{content}</u>;
    if (node.type === 'smallcaps') return <span key={key} className="live-smallcaps">{content}</span>;
    if (node.type === 'sup') return <sup key={key}>{content}</sup>;
    return <sub key={key}>{content}</sub>;
  });
}

function LineButton({ file, line, onEdit }: { file: string; line: number; onEdit: (line?: number, file?: string) => void }) {
  return (
    <button className="live-line" onClick={() => onEdit(line, file)} title={`Edit ${file}:${line}`} aria-label={`Edit ${file} line ${line}`}>
      {line}
    </button>
  );
}

function Located({ block, sourceFile, onEdit, children, className = '' }: { block: PreviewBlock; sourceFile: string; onEdit: (line?: number, file?: string) => void; children: ReactNode; className?: string }) {
  const file = block.file ?? sourceFile;
  return <div className={`live-block ${className}`} data-source-file={file} data-source-line={block.line}><LineButton file={file} line={block.line} onEdit={onEdit} />{children}</div>;
}

function BlockView({ block, document, sourceFile, refreshKey, onEdit, onOpenAsset }: {
  block: PreviewBlock;
  document: PreviewDocument;
  sourceFile: string;
  refreshKey: number;
  onEdit: (line?: number, file?: string) => void;
  onOpenAsset: (selection: AssetSelection) => void;
}) {
  if (block.type === 'title') {
    return (
      <Located block={block} sourceFile={sourceFile} onEdit={onEdit} className="live-title-block">
        <header className="live-title">
          <h1><InlineView nodes={block.title} document={document} /></h1>
          {block.author.length > 0 && <div className="live-author"><InlineView nodes={block.author} document={document} /></div>}
          {block.date.length > 0 && <div className="live-date"><InlineView nodes={block.date} document={document} /></div>}
        </header>
      </Located>
    );
  }
  if (block.type === 'heading') {
    const level = Math.min(6, block.level + 1);
    return (
      <Located block={block} sourceFile={sourceFile} onEdit={onEdit} className={`live-heading live-heading-${block.level}`}>
        {createElement(`h${level}`, {}, <>{block.number && <span className="live-heading-number">{block.number}</span>}<InlineView nodes={block.content} document={document} /></>)}
      </Located>
    );
  }
  if (block.type === 'paragraph') {
    return <Located block={block} sourceFile={sourceFile} onEdit={onEdit} className={block.align === 'center' ? 'live-centered' : ''}><p><InlineView nodes={block.content} document={document} /></p></Located>;
  }
  if (block.type === 'math') {
    return (
      <Located block={block} sourceFile={sourceFile} onEdit={onEdit} className="live-equation">
        <MathView tex={block.tex} display />
        {block.number && <span className="live-equation-number">({block.number})</span>}
      </Located>
    );
  }
  if (block.type === 'list') {
    const items = block.items.map((item, index) => block.description
      ? <div className="live-description-item" key={index}>{item.label && <dt><InlineView nodes={item.label} document={document} /></dt>}<dd><InlineView nodes={item.content} document={document} /></dd></div>
      : <li key={index}><InlineView nodes={item.content} document={document} /></li>);
    return <Located block={block} sourceFile={sourceFile} onEdit={onEdit} className="live-list">{block.description ? <dl>{items}</dl> : block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>}</Located>;
  }
  if (block.type === 'quote') {
    return <Located block={block} sourceFile={sourceFile} onEdit={onEdit}><blockquote><InlineView nodes={block.content} document={document} /></blockquote></Located>;
  }
  if (block.type === 'figure') {
    return (
      <Located block={block} sourceFile={sourceFile} onEdit={onEdit} className="live-float">
        <figure>
          <div className="live-figure-assets">
            {block.assets.length ? block.assets.map((asset) => (
              <LiveFigureAsset
                key={asset}
                selection={{ path: asset, from: block.file ?? sourceFile }}
                refreshKey={refreshKey}
                onOpen={onOpenAsset}
              />
            )) : <div className="live-asset"><span className="live-asset-type">FIG</span><small>No includegraphics asset found</small></div>}
          </div>
          <figcaption><strong>Figure {block.number}.</strong>{' '}<InlineView nodes={block.caption} document={document} /></figcaption>
        </figure>
      </Located>
    );
  }
  if (block.type === 'table') {
    return (
      <Located block={block} sourceFile={sourceFile} onEdit={onEdit} className="live-float">
        <figure>
          {block.caption.length > 0 && <figcaption className="live-table-caption"><strong>Table {block.number}.</strong>{' '}<InlineView nodes={block.caption} document={document} /></figcaption>}
          {block.rows.length > 0 ? (
            <>
              <div className="live-table-preview-note">Simplified table · exact typography and spacing remain in PDF</div>
              <div className="live-table-scroll"><table><tbody>{block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.cells.map((cell, cellIndex) => {
                  const Cell = row.header ? 'th' : 'td';
                  return <Cell key={cellIndex} colSpan={cell.colSpan}><InlineView nodes={cell.content} document={document} /></Cell>;
                })}</tr>
              ))}</tbody></table></div>
            </>
          ) : <div className="live-asset"><span className="live-asset-type">TABLE</span><small>Source could not be simplified · exact table remains in PDF</small></div>}
        </figure>
      </Located>
    );
  }
  if (block.type === 'code') {
    return <Located block={block} sourceFile={sourceFile} onEdit={onEdit}><pre className="live-code-block"><code>{block.content}</code></pre></Located>;
  }
  if (block.type === 'include') {
    return <Located block={block} sourceFile={sourceFile} onEdit={onEdit}><div className="live-notice"><strong>Included source</strong><span>{block.path}</span></div></Located>;
  }
  return <Located block={block} sourceFile={sourceFile} onEdit={onEdit}><div className="live-notice"><strong>{block.label}</strong>{block.detail && <span>{block.detail}</span>}</div></Located>;
}

export function LivePreview({ source, file, refreshKey = 0, onEdit, onTextEdit, onOpenAsset }: {
  source: string;
  file: string;
  refreshKey?: number;
  onEdit: (line?: number, file?: string) => void;
  onTextEdit: (edit: LiveSourceEdit) => boolean;
  onOpenAsset: (selection: AssetSelection) => void;
}) {
  const renderable = /\.tex$/i.test(file);
  const [expanded, setExpanded] = useState(() => sourceWithPreviewLocations(file, source));
  const [editProblem, setEditProblem] = useState<string | null>(null);
  useEffect(() => {
    const immediate = sourceWithPreviewLocations(file, source);
    setExpanded(immediate);
    if (!renderable) return;
    const controller = new AbortController();
    const load = async (path: string, signal: AbortSignal): Promise<PreviewIncludeFile | null> => {
      const response = await fetch(`/api/include?path=${encodeURIComponent(path)}`, { signal });
      return response.ok ? response.json() as Promise<PreviewIncludeFile> : null;
    };
    void expandLatexIncludes(file, source, load, controller.signal, { allowParent: true }).then((next) => {
      if (!controller.signal.aborted) setExpanded(next);
    }).catch(() => {});
    return () => controller.abort();
  }, [file, source, refreshKey, renderable]);
  useEffect(() => setEditProblem(null), [file]);
  const starts = useMemo(() => sourceLineStarts(expanded.text), [expanded.text]);
  const document = useMemo<PreviewDocument>(() => renderable
    ? mapLocations(parseLatexPreview(expanded.text), expanded.locations, file)
    : { blocks: [], footnotes: [], references: {}, approximated: [], wordCount: 0 }, [expanded, file, renderable]);
  const editing = useMemo<EditingContextValue>(() => ({
    canEdit: (textSource) => sourceRangeEditable(textSource, expanded, starts),
    resolve: (change) => resolveSourceEdit(change, expanded, starts, file),
    apply: (edit) => {
      const applied = onTextEdit(edit);
      if (applied) setEditProblem(null);
      return applied;
    },
    fail: setEditProblem,
  }), [expanded, file, onTextEdit, starts]);

  return (
    <div className="live-preview">
      <div className="live-preview-status">
        <span className="live-badge"><span className="live-dot" />LIVE EDITOR</span>
        <span>{document.wordCount.toLocaleString()} words</span>
        <span>{document.blocks.length} blocks</span>
        {document.approximated.length > 0 && (
          <span className="live-approx" title={`Approximated: ${document.approximated.join(', ')}`}>
            {document.approximated.length} construct{document.approximated.length === 1 ? '' : 's'} approximated
          </span>
        )}
        {editProblem && <span className="live-edit-problem" title={editProblem}>edit refreshed — retry</span>}
        <span className="spacer" />
        <span className="live-exact-note">Click prose to edit · protected items keep exact LaTeX · PDF is exact</span>
      </div>
      <div className="live-preview-scroll">
        <EditingContext.Provider value={editing}>
          <article className="live-paper" aria-label={`Live visual editor for ${file}`}>
            {!renderable ? (
              <div className="live-empty"><h2>Live editing is for .tex files</h2><p>Use Edit Code for bibliography, style, configuration, Markdown, and text files.</p></div>
            ) : document.blocks.length > 0
              ? document.blocks.map((block, index) => <BlockView key={`${block.type}-${block.file ?? file}-${block.line}-${index}`} block={block} document={document} sourceFile={file} refreshKey={refreshKey} onEdit={onEdit} onOpenAsset={onOpenAsset} />)
              : <div className="live-empty"><h2>Nothing renderable yet</h2><p>Start writing in Code; this page updates from the current source without compiling.</p></div>}
            {document.footnotes.length > 0 && (
              <section className="live-footnotes">
                <h2>Notes</h2>
                <ol>{document.footnotes.map((footnote) => (
                  <li id={`live-footnote-${footnote.number}`} key={footnote.number}><InlineView nodes={footnote.content} document={document} /></li>
                ))}</ol>
              </section>
            )}
          </article>
        </EditingContext.Provider>
      </div>
    </div>
  );
}
