// A small, self-contained unified-diff renderer for History. Git is line based,
// but LaTeX prose is often one paragraph per physical line. Treating a one-word
// edit as one deleted paragraph plus one added paragraph made the whole section
// look rewritten. Similar -/+ line pairs are therefore folded into one row with
// precise word-level marks; genuinely inserted/deleted lines stay line based.
import { diffWordsWithSpace } from 'diff';
import * as React from 'react';
import { useMemo, useState } from 'react';

type RowType = 'file' | 'hunk' | 'add' | 'del' | 'mod' | 'ctx';
interface Row { type: RowType; oldNo?: number; newNo?: number; text: string; oldText?: string; newText?: string }
interface FileSection { file: string; rows: Row[]; adds: number; dels: number; edits: number }

function parseDiff(diff: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0, newNo = 0, inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/ b\/(.+)$/);
      rows.push({ type: 'file', text: m ? m[1] : line.replace('diff --git ', '') });
      inHunk = false;
      continue;
    }
    // Skip file metadata and (for `git show`) the commit message before the hunks.
    if (!inHunk && !line.startsWith('@@')) continue;
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldNo = +m[1]; newNo = +m[2]; inHunk = true; rows.push({ type: 'hunk', text: line }); }
      continue;
    }
    const c = line[0];
    if (c === '+') { rows.push({ type: 'add', newNo, text: line.slice(1) }); newNo++; }
    else if (c === '-') { rows.push({ type: 'del', oldNo, text: line.slice(1) }); oldNo++; }
    else if (c === '\\') { /* "\ No newline at end of file" — ignore */ }
    else { rows.push({ type: 'ctx', oldNo, newNo, text: line.slice(1) }); oldNo++; newNo++; }
  }
  return rows;
}

/** A short one-to-one replacement is naturally an edit even when every word
 * changed. Long lines are paired only when enough text is shared, preventing
 * unrelated deleted/added paragraphs from being presented as one mutation. */
function isModification(oldText: string, newText: string): boolean {
  const longest = Math.max(oldText.length, newText.length);
  if (longest <= 120) return true;
  const unchanged = diffWordsWithSpace(oldText, newText)
    .filter((part) => !part.added && !part.removed)
    .reduce((sum, part) => sum + part.value.length, 0);
  return unchanged / longest >= 0.25;
}

/** Git emits a changed block as all '-' lines followed by all '+' lines. Pair
 * the common one-to-one case so prose appears once, with only its edits marked. */
function pairModifications(rows: Row[]): Row[] {
  const result: Row[] = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].type !== 'del') { result.push(rows[index]); index++; continue; }
    let delEnd = index;
    while (delEnd < rows.length && rows[delEnd].type === 'del') delEnd++;
    let addEnd = delEnd;
    while (addEnd < rows.length && rows[addEnd].type === 'add') addEnd++;
    const deleted = rows.slice(index, delEnd);
    const added = rows.slice(delEnd, addEnd);
    const canPair = deleted.length > 0 && deleted.length === added.length
      && deleted.every((row, offset) => isModification(row.text, added[offset].text));
    if (canPair) {
      for (let offset = 0; offset < deleted.length; offset++) {
        result.push({
          type: 'mod',
          oldNo: deleted[offset].oldNo,
          newNo: added[offset].newNo,
          text: '',
          oldText: deleted[offset].text,
          newText: added[offset].text,
        });
      }
    } else {
      result.push(...deleted, ...added);
    }
    index = addEnd;
  }
  return result;
}

/** Group the flat rows into per-file sections (with add/del counts). */
function toSections(rows: Row[]): FileSection[] {
  const sections: FileSection[] = [];
  let cur: FileSection | null = null;
  for (const r of rows) {
    if (r.type === 'file') { cur = { file: r.text, rows: [], adds: 0, dels: 0, edits: 0 }; sections.push(cur); continue; }
    if (!cur) { cur = { file: '(changes)', rows: [], adds: 0, dels: 0, edits: 0 }; sections.push(cur); }
    cur.rows.push(r);
  }
  return sections.map((section) => {
    const paired = pairModifications(section.rows);
    return {
      ...section,
      rows: paired,
      adds: paired.filter((row) => row.type === 'add').length,
      dels: paired.filter((row) => row.type === 'del').length,
      edits: paired.filter((row) => row.type === 'mod').length,
    };
  });
}

function InlineWordDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = useMemo(() => diffWordsWithSpace(oldText, newText), [oldText, newText]);
  return <>{parts.map((part, index) => (
    <span
      key={index}
      className={part.added ? 'dv-word-add' : part.removed ? 'dv-word-del' : undefined}
    >
      {part.value}
    </span>
  ))}</>;
}

export function DiffView({ diff, onRevertFile }: { diff: string; onRevertFile?: (file: string) => void }) {
  const sections = useMemo(() => toSections(parseDiff(diff)), [diff]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <div className="diffview">
      {sections.map((s, si) => {
        const isCollapsed = collapsed[s.file];
        return (
          <div key={si} className="dv-section">
            <div className="dv-file" onClick={() => setCollapsed((c) => ({ ...c, [s.file]: !isCollapsed }))} title="Click to collapse / expand">
              <span className="dv-file-caret">{isCollapsed ? '▸' : '▾'}</span>
              <span className="dv-file-name">{s.file}</span>
              <span className="dv-file-stat">
                {s.edits > 0 && <span className="edit">~{s.edits}</span>}
                {s.adds > 0 && <span className="add">+{s.adds}</span>}
                {s.dels > 0 && <span className="del"> −{s.dels}</span>}
              </span>
              {onRevertFile && s.file !== '(changes)' && (
                <button className="dv-file-revert" title={`Revert ${s.file} to this version`}
                        onClick={(e) => { e.stopPropagation(); onRevertFile(s.file); }}>↩</button>
              )}
            </div>
            {!isCollapsed && s.rows.map((r, i) =>
              r.type === 'hunk'
                ? <div key={i} className="dv-hunk">{r.text}</div>
                : (
                  <div key={i} className={`dv-row dv-${r.type}`}>
                    <span className="dv-num">{r.oldNo ?? ''}</span>
                    <span className="dv-num">{r.newNo ?? ''}</span>
                    <span className="dv-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : r.type === 'mod' ? '±' : ''}</span>
                    <span className="dv-code">
                      {r.type === 'mod'
                        ? <InlineWordDiff oldText={r.oldText ?? ''} newText={r.newText ?? ''} />
                        : r.text || ' '}
                    </span>
                  </div>
                ),
            )}
          </div>
        );
      })}
    </div>
  );
}
