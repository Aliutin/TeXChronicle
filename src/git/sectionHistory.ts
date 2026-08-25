import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { buildSectionGraph, latexIncludedFiles, type SectionGraph, type SectionTimelineRecord, type SectionVersionRecord } from '../latex/sections.js';
import { historyRepo } from './historyRepo.js';
import { git, gitOrNull } from './exec.js';
import { createCheckpointUnlocked } from './checkpoints.js';
import { withLock } from '../lock.js';
import { readTextFile, writeTextFile } from '../preview/filesApi.js';
import { suppressNextChange } from '../watch/fileWatcher.js';

const REF = 'refs/latex-preview/checkpoints';
const SHA_RE = /^[0-9a-f]{7,64}$/;
const SECTION_ID_RE = /^sec-[0-9a-f]{12}$/;

interface CachedGraph {
  head: string;
  renderedMain?: string;
  graph: SectionGraph;
  checkpointCount: number;
}

const graphCache = new Map<string, CachedGraph>();

async function checkpointHead(root: string): Promise<{ head: string; env: NodeJS.ProcessEnv }> {
  const { env } = await historyRepo(root);
  const head = (await gitOrNull(root, ['rev-parse', '--verify', '-q', REF], env))?.trim() ?? '';
  return { head, env };
}

const normalizeProjectPath = (path: string): string => {
  const normalized = posix.normalize(path.replace(/\\/g, '/').replace(/^\.\/+/, ''));
  return normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized) ? '' : normalized;
};

function resolveIncludedPath(currentPath: string, target: string, lookup: Map<string, string>): string | undefined {
  const clean = normalizeProjectPath(target);
  if (!clean || /[{}\\]/.test(clean)) return undefined; // dynamically-generated path
  const names = clean.toLocaleLowerCase().endsWith('.tex') ? [clean] : [clean, `${clean}.tex`];
  for (const name of names) {
    const fromCurrent = normalizeProjectPath(posix.join(posix.dirname(currentPath), name));
    const found = lookup.get(fromCurrent.toLocaleLowerCase()) ?? lookup.get(name.toLocaleLowerCase());
    if (found) return found;
  }
  return undefined;
}

async function filesAt(root: string, sha: string, env: NodeJS.ProcessEnv, renderedMain?: string): Promise<Array<{ path: string; source: string }>> {
  const listed = await git(root, ['ls-tree', '-r', '--name-only', sha], env);
  const paths = listed
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => /\.tex$/i.test(path) && !path.startsWith('.latex-preview/') && !path.startsWith('.claude/'));
  const lookup = new Map(paths.map((path) => [normalizeProjectPath(path).toLocaleLowerCase(), path]));
  const loaded = new Map<string, { path: string; source: string }>();
  const load = async (path: string): Promise<{ path: string; source: string }> => {
    const hit = loaded.get(path);
    if (hit) return hit;
    const file = { path, source: await git(root, ['show', `${sha}:${path}`], env) };
    loaded.set(path, file);
    return file;
  };

  const walkDocument = async (main: string): Promise<Array<{ path: string; source: string }>> => {
    const ordered: Array<{ path: string; source: string }> = [];
    const seen = new Set<string>();
    const visit = async (path: string): Promise<void> => {
      if (seen.has(path)) return;
      seen.add(path);
      const file = await load(path);
      ordered.push(file);
      for (const target of latexIncludedFiles(file.source)) {
        const included = resolveIncludedPath(path, target, lookup);
        if (included) await visit(included);
      }
    };
    await visit(main);
    return ordered;
  };

  // The compile records its resolved main file beside the exact PDF. Restricting
  // the semantic graph to that document is essential in folders that also keep
  // old standalone drafts, response letters, or supplement .tex files.
  const normalizedMain = renderedMain ? normalizeProjectPath(renderedMain) : '';
  const selectedMain = normalizedMain ? lookup.get(normalizedMain.toLocaleLowerCase()) : undefined;
  if (selectedMain) return walkDocument(selectedMain);

  // Older checkpoints predate render metadata. A conventional main.tex is a
  // safe fallback; otherwise retain the old all-.tex behaviour instead of
  // guessing among several independent documents.
  const conventional = paths.find((path) => /(^|\/)main\.tex$/i.test(path));
  if (conventional) return walkDocument(conventional);

  const files: Array<{ path: string; source: string }> = [];
  for (const path of paths.sort((a, b) => a.localeCompare(b))) {
    files.push(await load(path));
  }
  return files;
}

async function renderedMainAt(root: string, sha: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(root, '.latex-preview', 'renders', `${sha}.json`), 'utf8')) as { mainFile?: unknown };
    return typeof parsed.mainFile === 'string' && parsed.mainFile.trim() ? parsed.mainFile : undefined;
  } catch {
    return undefined;
  }
}

/** Build lazily, and only rebuild when the hidden checkpoint ref advances. */
export async function loadSectionGraph(root: string): Promise<CachedGraph> {
  const { head, env } = await checkpointHead(root);
  // Metadata is written just after the checkpoint ref advances. Include the
  // head's recorded main file in the cache identity so a request arriving in
  // that narrow interval cannot pin an all-.tex fallback graph until the next
  // source edit.
  const renderedMain = head ? await renderedMainAt(root, head) : undefined;
  const cached = graphCache.get(root);
  if (cached?.head === head && cached.renderedMain === renderedMain) return cached;
  if (!head) {
    const empty = { head: '', renderedMain: undefined, graph: buildSectionGraph([]), checkpointCount: 0 };
    graphCache.set(root, empty);
    return empty;
  }

  const log = await git(root, ['log', '--reverse', '--format=%H%x09%cI', REF], env);
  const rows: Array<{ sha: string; time: string }> = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha, time] = line.split('\t');
    if (!SHA_RE.test(sha) || !time) continue;
    rows.push({ sha, time });
  }
  const recordedMains = await Promise.all(rows.map(({ sha }) => renderedMainAt(root, sha)));
  let activeMain = recordedMains.find((main): main is string => Boolean(main));
  const checkpoints = [];
  for (let index = 0; index < rows.length; index++) {
    if (recordedMains[index]) activeMain = recordedMains[index];
    const { sha, time } = rows[index];
    checkpoints.push({ sha, time, files: await filesAt(root, sha, env, activeMain) });
  }
  const next = { head, renderedMain, graph: buildSectionGraph(checkpoints), checkpointCount: checkpoints.length };
  graphCache.set(root, next);
  return next;
}

export interface SectionVersionSummary {
  versionId: string;
  sha: string;
  time: string;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  parentId?: string;
  changes: SectionVersionRecord['changes'];
  confidence: SectionVersionRecord['confidence'];
  matchScore: number;
  predecessorIds: string[];
  hasPdf: boolean;
}

export interface SectionSummary {
  id: string;
  title: string;
  label?: string;
  command: SectionTimelineRecord['command'];
  level: number;
  appendix: boolean;
  path: string;
  parentId?: string;
  order: number;
  present: boolean;
  versions: SectionVersionSummary[];
}

export interface SectionHistoryPayload {
  head: string;
  checkpointCount: number;
  sections: SectionSummary[];
}

export async function listSectionHistory(root: string): Promise<SectionHistoryPayload> {
  const { head, graph, checkpointCount } = await loadSectionGraph(root);
  const renderFiles = await readdir(join(root, '.latex-preview', 'renders')).catch(() => [] as string[]);
  const pdfs = new Set(renderFiles.filter((name) => name.endsWith('.pdf')).map((name) => name.slice(0, -4)));
  const sections: SectionSummary[] = [];
  for (const section of graph.sections) {
    const versions: SectionVersionSummary[] = [];
    for (const version of [...section.versions].reverse()) {
      versions.push({
        versionId: version.versionId,
        sha: version.sha,
        time: version.time,
        title: version.title,
        path: version.path,
        startLine: version.startLine,
        endLine: version.endLine,
        parentId: version.parentId,
        changes: version.changes,
        confidence: version.confidence,
        matchScore: version.matchScore,
        predecessorIds: version.predecessorIds,
        hasPdf: pdfs.has(version.sha),
      });
    }
    sections.push({
      id: section.id,
      title: section.title,
      label: section.label,
      command: section.command,
      level: section.level,
      appendix: section.appendix,
      path: section.path,
      parentId: section.parentId,
      order: section.order,
      present: section.present,
      versions,
    });
  }
  return { head, checkpointCount, sections };
}

function versionAt(graph: SectionGraph, sectionId: string, sha: string): { timeline: SectionTimelineRecord; version: SectionVersionRecord; index: number } {
  if (!SECTION_ID_RE.test(sectionId)) throw new Error('invalid section id');
  if (!SHA_RE.test(sha)) throw new Error('invalid checkpoint id');
  const timeline = graph.sections.find((section) => section.id === sectionId);
  if (!timeline) throw new Error('unknown section');
  const index = timeline.versions.findIndex((version) => version.sha === sha);
  if (index < 0) throw new Error('that checkpoint is not a version of this section');
  return { timeline, version: timeline.versions[index], index };
}

export interface SectionDiffResult {
  sectionId: string;
  sha: string;
  predecessorSha?: string;
  title: string;
  previousTitle?: string;
  scope: 'text' | 'subtree';
  diff: string;
}

export async function getSectionDiff(root: string, sectionId: string, sha: string, subtree = false): Promise<SectionDiffResult> {
  const { graph } = await loadSectionGraph(root);
  const { timeline, version, index } = versionAt(graph, sectionId, sha);
  const before = index > 0 ? timeline.versions[index - 1] : undefined;
  const previousSource = before ? (subtree ? before.source : before.ownSource) : '';
  const currentSource = subtree ? version.source : version.ownSource;
  const display = version.label || version.title || sectionId;
  const patch = createTwoFilesPatch(
    `${display} (previous)`,
    `${display} (${version.time})`,
    previousSource,
    currentSource,
    before?.time ?? '',
    version.time,
    { context: 4 },
  );
  return {
    sectionId,
    sha,
    predecessorSha: before?.sha,
    title: version.title,
    previousTitle: before?.title,
    scope: subtree ? 'subtree' : 'text',
    diff: `diff --git a/${display}.tex b/${display}.tex\n${patch}`,
  };
}

/**
 * Restore one semantic section, including its current subtree. The current
 * project is checkpointed first, exactly like full/file restore, so the action
 * is itself reversible and never touches the user's Git index or branches.
 */
export async function restoreSection(root: string, sectionId: string, sha: string): Promise<{ path: string; title: string }> {
  if (!SECTION_ID_RE.test(sectionId)) throw new Error('invalid section id');
  if (!SHA_RE.test(sha)) throw new Error('invalid checkpoint id');
  return withLock(root, async () => {
    const snapshot = await createCheckpointUnlocked(root);
    if (!snapshot.created && snapshot.reason !== 'unchanged') {
      throw new Error(
        `Refusing to restore: TeXChronicle could not snapshot your current files first, so this could not be undone (${snapshot.error ?? snapshot.reason}). Nothing has been changed.`,
      );
    }

    // A newly-created safety checkpoint advances the ref; force the graph to
    // include it before deciding where this section lives now.
    graphCache.delete(root);
    const { graph } = await loadSectionGraph(root);
    const { version: target } = versionAt(graph, sectionId, sha);
    const current = graph.current.get(sectionId);
    if (!current) throw new Error('This section no longer exists in the current document. Restore the containing section or project first.');

    const file = await readTextFile(root, current.path);
    if (file.slice(current.start, current.end) !== current.source) {
      throw new Error('The section changed while its history was being prepared. Nothing has been restored; retry after the current edit finishes.');
    }
    const restored = file.slice(0, current.start) + target.source + file.slice(current.end);
    suppressNextChange(join(root, current.path));
    await writeTextFile(root, current.path, restored);
    graphCache.delete(root);
    return { path: current.path, title: target.title };
  });
}

export function forgetSectionGraph(root?: string): void {
  if (root) graphCache.delete(root); else graphCache.clear();
}
