import { createHash } from 'node:crypto';

export const SECTION_COMMANDS = [
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
] as const;

export type SectionCommand = typeof SECTION_COMMANDS[number];

const LEVEL: Record<SectionCommand, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

export interface ParsedSection {
  path: string;
  command: SectionCommand;
  level: number;
  starred: boolean;
  title: string;
  normalizedTitle: string;
  label?: string;
  appendix: boolean;
  start: number;
  headingEnd: number;
  end: number;
  startLine: number;
  endLine: number;
  parentIndex?: number;
  order: number;
  siblingOrder: number;
  source: string;
  ownSource: string;
  matchText: string;
  contentHash: string;
}

export interface SectionCheckpointInput {
  sha: string;
  time: string;
  files: Array<{ path: string; source: string }>;
}

export type SectionChange = 'created' | 'edited' | 'renamed' | 'moved' | 'reordered' | 'structure' | 'descendant';
export type MatchConfidence = 'exact' | 'high' | 'medium' | 'low';

export interface SectionVersionRecord {
  versionId: string;
  sectionId: string;
  sha: string;
  time: string;
  title: string;
  label?: string;
  command: SectionCommand;
  level: number;
  appendix: boolean;
  path: string;
  parentId?: string;
  order: number;
  siblingOrder: number;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  source: string;
  ownSource: string;
  contentHash: string;
  childIds: string[];
  childVersionIds: string[];
  predecessorIds: string[];
  changes: SectionChange[];
  confidence: MatchConfidence;
  matchScore: number;
}

export interface SectionTimelineRecord {
  id: string;
  title: string;
  label?: string;
  command: SectionCommand;
  level: number;
  appendix: boolean;
  path: string;
  parentId?: string;
  order: number;
  present: boolean;
  versions: SectionVersionRecord[];
}

export interface SectionState extends SectionVersionRecord {
  normalizedTitle: string;
  matchText: string;
  lastVersionId: string;
}

export interface SectionGraph {
  sections: SectionTimelineRecord[];
  statesByCheckpoint: Map<string, Map<string, SectionState>>;
  current: Map<string, SectionState>;
}

const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');
const normalizeEol = (value: string): string => value.replace(/\r\n?/g, '\n');

function escapedAt(source: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

/**
 * Blank comments and literal/code environments while retaining every character
 * position and newline. Section offsets found in the result therefore remain
 * valid in the original source.
 */
function maskNonDocumentText(source: string): string {
  const chars = [...source];
  let comment = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (comment) {
      if (c === '\n' || c === '\r') comment = false;
      else chars[i] = ' ';
      continue;
    }
    if (c === '%' && !escapedAt(source, i)) {
      chars[i] = ' ';
      comment = true;
    }
  }

  let masked = chars.join('');
  const literal = /\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}/gi;
  for (;;) {
    const begin = literal.exec(masked);
    if (!begin) break;
    const name = begin[1];
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const endRe = new RegExp(`\\\\end\\s*\\{${escaped}\\}`, 'gi');
    endRe.lastIndex = literal.lastIndex;
    const end = endRe.exec(masked);
    const until = end ? end.index + end[0].length : masked.length;
    for (let i = begin.index; i < until; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    masked = chars.join('');
    literal.lastIndex = until;
  }
  return masked;
}

function readBalanced(source: string, openAt: number, open: string, close: string): number {
  if (source[openAt] !== open) return -1;
  let depth = 0;
  for (let i = openAt; i < source.length; i++) {
    if (escapedAt(source, i)) continue;
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i;
  }
  return -1;
}

function skipSpace(source: string, from: number): number {
  let i = from;
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

/** Human-readable title for the tree and fuzzy matcher, not a TeX renderer. */
export function latexTitleToText(raw: string): string {
  return raw
    .replace(/\\texorpdfstring\s*\{([^{}]*)\}\s*\{[^{}]*\}/g, '$1')
    .replace(/\\(?:label|index|footnote|thanks)\s*\{[^{}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[{}$]/g, ' ')
    .replace(/~|\\[,;:! ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitle(raw: string): string {
  return latexTitleToText(raw)
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Input/include targets in source order, with comments and literal examples ignored. */
export function latexIncludedFiles(source: string): string[] {
  const masked = maskNonDocumentText(source);
  const includes: string[] = [];
  const command = /\\(?:input|include|subfile)\s*\{([^{}]+)\}/g;
  for (;;) {
    const match = command.exec(masked);
    if (!match) break;
    const target = match[1].trim();
    if (target) includes.push(target);
  }
  return includes;
}

function proseForMatching(source: string): string {
  return maskNonDocumentText(source)
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\\(?:label|ref|eqref|autoref|cite[a-zA-Z]*|includegraphics)\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}/g, ' ')
    .replace(/\\begin\s*\{[^{}]*\}|\\end\s*\{[^{}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[{}\[\]$&#_^~]/g, ' ')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0, hi = starts.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid;
  }
  return lo + 1;
}

/** Parse sectioning commands from one source file into a proper nested tree. */
export function parseLatexSections(source: string, path = 'main.tex'): ParsedSection[] {
  const masked = maskNonDocumentText(source);
  const beginsDocument = masked.search(/\\begin\s*\{document\}/);
  const scanStart = beginsDocument >= 0 ? beginsDocument : 0;
  const endsDocument = masked.indexOf('\\end{document}', scanStart);
  const scanEnd = endsDocument >= 0 ? endsDocument : masked.length;
  const appendixAt = masked.indexOf('\\appendix', scanStart);
  const starts = lineStarts(source);
  const commandRe = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\b/g;
  commandRe.lastIndex = scanStart;

  const found: Array<Omit<ParsedSection, 'end' | 'endLine' | 'parentIndex' | 'siblingOrder' | 'source' | 'ownSource' | 'matchText' | 'contentHash'>> = [];
  for (;;) {
    const match = commandRe.exec(masked);
    if (!match || match.index >= scanEnd) break;
    const command = match[1] as SectionCommand;
    let at = skipSpace(masked, commandRe.lastIndex);
    const starred = masked[at] === '*';
    if (starred) at = skipSpace(masked, at + 1);
    if (masked[at] === '[') {
      const close = readBalanced(masked, at, '[', ']');
      if (close < 0) continue;
      at = skipSpace(masked, close + 1);
    }
    if (masked[at] !== '{') continue;
    const close = readBalanced(masked, at, '{', '}');
    if (close < 0) continue;
    const rawTitle = source.slice(at + 1, close);
    found.push({
      path,
      command,
      level: LEVEL[command],
      starred,
      title: latexTitleToText(rawTitle) || rawTitle.trim() || '(untitled)',
      normalizedTitle: normalizeTitle(rawTitle),
      appendix: appendixAt >= 0 && match.index > appendixAt,
      start: match.index,
      headingEnd: close + 1,
      startLine: lineAt(starts, match.index),
      order: found.length,
      label: undefined,
    });
    commandRe.lastIndex = close + 1;
  }

  const sections: ParsedSection[] = [];
  const stack: number[] = [];
  for (let i = 0; i < found.length; i++) {
    const cur = found[i];
    while (stack.length && found[stack[stack.length - 1]].level >= cur.level) stack.pop();
    const parentIndex = stack.length ? stack[stack.length - 1] : undefined;
    stack.push(i);
    let end = scanEnd;
    for (let n = i + 1; n < found.length; n++) {
      if (found[n].level <= cur.level) { end = found[n].start; break; }
    }
    const nextChild = found.find((candidate, n) => n > i && candidate.start < end && candidate.level > cur.level);
    const labelAreaEnd = Math.min(end, nextChild?.start ?? end, cur.headingEnd + 600);
    const labelArea = masked.slice(cur.headingEnd, labelAreaEnd);
    const labelMatch = labelArea.match(/^\s*\\label\s*\{([^{}]+)\}/);
    sections.push({
      ...cur,
      label: labelMatch?.[1]?.trim() || undefined,
      end,
      endLine: lineAt(starts, Math.max(cur.start, end - 1)),
      parentIndex,
      siblingOrder: 0,
      source: '',
      ownSource: '',
      matchText: '',
      contentHash: '',
    });
  }

  const siblingCounts = new Map<number | undefined, number>();
  for (const section of sections) {
    section.siblingOrder = siblingCounts.get(section.parentIndex) ?? 0;
    siblingCounts.set(section.parentIndex, section.siblingOrder + 1);
  }

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    section.source = source.slice(section.start, section.end);
    const directChildren = sections
      .filter((candidate) => candidate.parentIndex === i)
      .sort((a, b) => a.start - b.start);
    let cursor = section.start;
    const own: string[] = [];
    for (const child of directChildren) {
      own.push(source.slice(cursor, child.start));
      cursor = child.end;
    }
    own.push(source.slice(cursor, section.end));
    section.ownSource = own.join('\n');
    section.matchText = proseForMatching(section.ownSource);
    section.contentHash = sha1(normalizeEol(section.ownSource).replace(/[ \t]+$/gm, '').trim());
  }
  return sections;
}

function words(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function features(value: string): Set<string> {
  const tokens = words(value);
  if (tokens.length < 8) return new Set(tokens);
  const out = new Set<string>();
  for (let i = 0; i + 2 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const item of a) if (b.has(item)) common++;
  return common / (a.size + b.size - common);
}

function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  // Titles are short. Keeping only one DP row bounds memory even for a macro-
  // generated heading that is unexpectedly long.
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function titleSimilarity(a: string, b: string): number {
  if (a === b && a) return 1;
  return Math.max(editSimilarity(a, b), jaccard(new Set(words(a)), new Set(words(b))));
}

interface CandidateSection extends ParsedSection {
  globalOrder: number;
  parentTitle: string;
  previousTitle: string;
  nextTitle: string;
}

interface MatchableState extends SectionState {
  parentTitle: string;
  previousTitle: string;
  nextTitle: string;
}

function scorePair(old: MatchableState, next: CandidateSection, oldCount: number, newCount: number): number {
  if (old.label && next.label && old.label === next.label) return 2;
  if (old.label && next.label && old.label !== next.label) return -1;

  let score = 0;
  const title = titleSimilarity(old.normalizedTitle, next.normalizedTitle);
  score += title === 1 ? 0.46 : title * 0.30;
  score += jaccard(features(old.matchText), features(next.matchText)) * 0.36;
  score += old.level === next.level ? 0.08 : -0.12 * Math.min(2, Math.abs(old.level - next.level));
  if (old.path === next.path) score += 0.05;
  // A renamed/re-written section often keeps its structural slot even when
  // title and prose no longer overlap. This is intentionally supporting
  // evidence rather than an identity by itself; neighbours/parent/path still
  // participate in the global assignment.
  if (old.siblingOrder === next.siblingOrder) score += 0.12;

  const oldParent = old.parentId ? old.parentId : '';
  // parentTitle is used here rather than parent identity because current IDs are
  // assigned by this very matching pass. Exact identities are applied below.
  const priorParentTitle = old.parentTitle;
  if (priorParentTitle && next.parentTitle) score += titleSimilarity(priorParentTitle, next.parentTitle) * 0.08;
  else if (!oldParent && !next.parentTitle) score += 0.04;

  const before = titleSimilarity(old.previousTitle, next.previousTitle);
  const after = titleSimilarity(old.nextTitle, next.nextTitle);
  score += (before + after) * 0.06;

  const oldPos = oldCount <= 1 ? 0 : old.order / (oldCount - 1);
  const newPos = newCount <= 1 ? 0 : next.globalOrder / (newCount - 1);
  score += Math.max(0, 1 - Math.abs(oldPos - newPos)) * 0.10;
  return score;
}

function confidence(score: number): MatchConfidence {
  if (score >= 1.5) return 'exact';
  if (score >= 0.78) return 'high';
  if (score >= 0.58) return 'medium';
  return 'low';
}

function makeSectionId(checkpoint: string, section: CandidateSection, ordinal: number): string {
  return `sec-${sha1(`${checkpoint}\0${section.path}\0${section.command}\0${ordinal}\0${section.normalizedTitle}`).slice(0, 12)}`;
}

/**
 * Build a semantic graph over a chronological checkpoint stream. Matching is
 * global (not greedy in source order): exact labels win, followed by a weighted
 * combination of title, direct text, hierarchy, neighbours, file and order.
 */
export function buildSectionGraph(checkpoints: SectionCheckpointInput[]): SectionGraph {
  const timelines = new Map<string, SectionTimelineRecord>();
  const statesByCheckpoint = new Map<string, Map<string, SectionState>>();
  let previous: SectionState[] = [];

  for (const checkpoint of checkpoints) {
    const parsed: CandidateSection[] = [];
    // Callers provide document order (main file followed by its input/include
    // traversal). Keeping it here makes structural order useful evidence even
    // when filenames are alphabetically unrelated to reading order.
    for (const file of checkpoint.files) {
      const fileSections = parseLatexSections(file.source, file.path);
      for (const section of fileSections) {
        const parent = section.parentIndex === undefined ? undefined : fileSections[section.parentIndex];
        const before = fileSections[section.order - 1];
        const after = fileSections[section.order + 1];
        parsed.push({
          ...section,
          globalOrder: parsed.length,
          parentTitle: parent?.normalizedTitle ?? '',
          previousTitle: before?.normalizedTitle ?? '',
          nextTitle: after?.normalizedTitle ?? '',
        });
      }
    }

    const prior: MatchableState[] = previous.map((state, i) => ({
      ...state,
      previousTitle: previous[i - 1]?.normalizedTitle ?? '',
      nextTitle: previous[i + 1]?.normalizedTitle ?? '',
      parentTitle: state.parentId ? previous.find((candidate) => candidate.sectionId === state.parentId)?.normalizedTitle ?? '' : '',
    }));

    const pairs: Array<{ oldIndex: number; newIndex: number; score: number }> = [];
    for (let oi = 0; oi < prior.length; oi++) {
      for (let ni = 0; ni < parsed.length; ni++) {
        const score = scorePair(prior[oi], parsed[ni], prior.length, parsed.length);
        if (score >= 0.43 || score >= 1.5) pairs.push({ oldIndex: oi, newIndex: ni, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score || a.oldIndex - b.oldIndex || a.newIndex - b.newIndex);
    const matchedOld = new Set<number>();
    const matchedNew = new Set<number>();
    const matchForNew = new Map<number, { old: SectionState; score: number }>();
    for (const pair of pairs) {
      if (matchedOld.has(pair.oldIndex) || matchedNew.has(pair.newIndex)) continue;
      matchedOld.add(pair.oldIndex);
      matchedNew.add(pair.newIndex);
      matchForNew.set(pair.newIndex, { old: previous[pair.oldIndex], score: pair.score });
    }

    const ids = parsed.map((section, index) => matchForNew.get(index)?.old.sectionId ?? makeSectionId(checkpoint.sha, section, index));
    const states: SectionState[] = parsed.map((section, index) => {
      const matched = matchForNew.get(index);
      const parentId = section.parentIndex === undefined
        ? undefined
        : ids[parsed.findIndex((candidate) => candidate.path === section.path && candidate.order === section.parentIndex)];
      // findIndex above is deliberate: parentIndex is local to one source file,
      // while `parsed` is the concatenated project sequence.
      return {
        versionId: '',
        sectionId: ids[index],
        sha: checkpoint.sha,
        time: checkpoint.time,
        title: section.title,
        normalizedTitle: section.normalizedTitle,
        label: section.label,
        command: section.command,
        level: section.level,
        appendix: section.appendix,
        path: section.path,
        parentId,
        order: section.globalOrder,
        siblingOrder: section.siblingOrder,
        start: section.start,
        end: section.end,
        startLine: section.startLine,
        endLine: section.endLine,
        source: section.source,
        ownSource: section.ownSource,
        matchText: section.matchText,
        contentHash: section.contentHash,
        childIds: [],
        childVersionIds: [],
        predecessorIds: matched ? [matched.old.lastVersionId] : [],
        changes: [],
        confidence: matched ? confidence(matched.score) : 'exact',
        matchScore: matched?.score ?? 2,
        lastVersionId: matched?.old.lastVersionId ?? '',
      };
    });

    const currentById = new Map(states.map((state) => [state.sectionId, state]));
    for (const state of states) {
      if (state.parentId) currentById.get(state.parentId)?.childIds.push(state.sectionId);
    }

    const previousById = new Map(previous.map((state) => [state.sectionId, state]));
    // Children first. Their final version IDs become the parent's descendant
    // fingerprint, so an Appendix timeline receives a version when one of its
    // subsections changes even if the Appendix's own prose did not.
    for (const state of [...states].reverse()) {
      const old = previousById.get(state.sectionId);
      state.childVersionIds = state.childIds.map((id) => currentById.get(id)?.lastVersionId ?? '');
      const changes: SectionChange[] = [];
      if (!old) changes.push('created');
      else {
        if (old.contentHash !== state.contentHash) changes.push('edited');
        if (old.normalizedTitle !== state.normalizedTitle) changes.push('renamed');
        if (old.path !== state.path || old.parentId !== state.parentId) changes.push('moved');
        else if (old.siblingOrder !== state.siblingOrder) changes.push('reordered');
        if (old.childIds.join('\0') !== state.childIds.join('\0')) changes.push('structure');
        else if (old.childVersionIds.join('\0') !== state.childVersionIds.join('\0')) changes.push('descendant');
      }

      if (changes.length) {
        state.changes = changes;
        state.versionId = `${state.sectionId}@${checkpoint.sha}`;
        state.lastVersionId = state.versionId;
        const version: SectionVersionRecord = {
          versionId: state.versionId,
          sectionId: state.sectionId,
          sha: state.sha,
          time: state.time,
          title: state.title,
          label: state.label,
          command: state.command,
          level: state.level,
          appendix: state.appendix,
          path: state.path,
          parentId: state.parentId,
          order: state.order,
          siblingOrder: state.siblingOrder,
          start: state.start,
          end: state.end,
          startLine: state.startLine,
          endLine: state.endLine,
          source: state.source,
          ownSource: state.ownSource,
          contentHash: state.contentHash,
          childIds: [...state.childIds],
          childVersionIds: [...state.childVersionIds],
          predecessorIds: [...state.predecessorIds],
          changes: [...changes],
          confidence: state.confidence,
          matchScore: state.matchScore,
        };
        const timeline = timelines.get(state.sectionId);
        if (timeline) timeline.versions.push(version);
        else timelines.set(state.sectionId, {
          id: state.sectionId,
          title: state.title,
          label: state.label,
          command: state.command,
          level: state.level,
          appendix: state.appendix,
          path: state.path,
          parentId: state.parentId,
          order: state.order,
          present: true,
          versions: [version],
        });
      } else if (old) {
        state.versionId = old.versionId;
        state.lastVersionId = old.lastVersionId;
        state.predecessorIds = old.predecessorIds;
      }

      const timeline = timelines.get(state.sectionId)!;
      timeline.title = state.title;
      timeline.label = state.label;
      timeline.command = state.command;
      timeline.level = state.level;
      timeline.appendix = state.appendix;
      timeline.path = state.path;
      timeline.parentId = state.parentId;
      timeline.order = state.order;
      timeline.present = true;
    }

    const active = new Set(states.map((state) => state.sectionId));
    for (const timeline of timelines.values()) if (!active.has(timeline.id)) timeline.present = false;
    const byId = new Map(states.map((state) => [state.sectionId, state]));
    statesByCheckpoint.set(checkpoint.sha, byId);
    previous = states;
  }

  const current = checkpoints.length
    ? statesByCheckpoint.get(checkpoints[checkpoints.length - 1].sha) ?? new Map<string, SectionState>()
    : new Map<string, SectionState>();
  return {
    sections: [...timelines.values()].sort((a, b) => Number(b.present) - Number(a.present) || a.order - b.order || a.title.localeCompare(b.title)),
    statesByCheckpoint,
    current,
  };
}
