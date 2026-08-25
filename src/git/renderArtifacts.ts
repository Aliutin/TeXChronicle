import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { historyRepo } from './historyRepo.js';
import { gitOrNull } from './exec.js';

const REF = 'refs/latex-preview/checkpoints';
const SUCCESS_REF = 'refs/latex-preview/successful';
const SHA_RE = /^[0-9a-f]{7,64}$/;
const ARTIFACT_RE = /^([0-9a-f]{7,64})\.pdf$/;

/**
 * How many stored renders to keep. `0` keeps every one.
 *
 * A render is written on every successful compile and nothing ever removed one,
 * so `.latex-preview/renders/` grew by a full PDF per save — for a figure-heavy
 * paper, hundreds of megabytes inside the author's Dropbox folder, synchronised
 * to every one of their machines, with no setting and nothing on screen saying
 * where it went. Fifty is well past the point where anyone scrolls back in
 * History, and losing an old one costs a "View PDF" button: readRenderArtifact
 * already answers null for a missing file and the UI degrades to the source
 * diff, which is why deletion is safe here at all.
 */
const DEFAULT_KEEP_RENDERS = 50;

function keepLimit(): number {
  const configured = process.env.TEXCHRONICLE_KEEP_RENDERS;
  if (configured === undefined || configured.trim() === '') return DEFAULT_KEEP_RENDERS;
  const value = Number(configured.trim());
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_KEEP_RENDERS;
}

export interface RenderMetadata {
  checkpoint: string;
  created: string;
  mainFile: string;
  engine: string;
  backend: string;
  bytes: number;
}

export const renderArtifactPath = (root: string, sha: string): string =>
  join(root, '.latex-preview', 'renders', `${sha}.pdf`);

const metadataPath = (root: string, sha: string): string =>
  join(root, '.latex-preview', 'renders', `${sha}.json`);

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Preserve the exact PDF produced for a checkpoint. Files are content-addressed
 * by the source commit and live outside the checkpoint tree, so binary PDFs do
 * not inflate Git history; a Dropbox-synchronised project still carries them.
 */
export async function saveRenderArtifact(
  root: string,
  sha: string,
  pdf: Uint8Array,
  info: { mainFile: string; engine: string; backend: string },
): Promise<void> {
  if (!SHA_RE.test(sha)) throw new Error('invalid checkpoint id');
  const dir = join(root, '.latex-preview', 'renders');
  const dest = renderArtifactPath(root, sha);
  await mkdir(dir, { recursive: true });
  if (await exists(dest)) { await pruneRenders(root, sha); return; } // repeated compile of unchanged source

  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const pdfTmp = join(dir, `.${sha}-${suffix}.pdf.tmp`);
  const jsonTmp = join(dir, `.${sha}-${suffix}.json.tmp`);
  const metadata: RenderMetadata = {
    checkpoint: sha,
    created: new Date().toISOString(),
    mainFile: info.mainFile,
    engine: info.engine,
    backend: info.backend,
    bytes: pdf.byteLength,
  };
  try {
    await writeFile(pdfTmp, pdf);
    await writeFile(jsonTmp, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
    // Another process may have won the same checkpoint while we wrote. Keep the
    // first complete artifact and discard ours rather than replacing in place.
    if (!(await exists(dest))) await rename(pdfTmp, dest);
    if (!(await exists(metadataPath(root, sha)))) await rename(jsonTmp, metadataPath(root, sha));
  } finally {
    await rm(pdfTmp, { force: true }).catch(() => {});
    await rm(jsonTmp, { force: true }).catch(() => {});
  }
  await pruneRenders(root, sha);
}

/**
 * Keep the newest `TEXCHRONICLE_KEEP_RENDERS` renders and delete the rest.
 *
 * Newest by file mtime, which is the order they were produced in; the two shas
 * that must survive regardless are the one just written and whatever the
 * successful-render marker points at, because that second one is the PDF the
 * workspace is showing and comment resolution is anchored to — it can easily be
 * older than the newest N after a restore. Read with a plain `rev-parse` rather
 * than through `latestCheckpointSha`, which seeds the marker as a side effect:
 * a cleanup path has no business writing refs.
 *
 * Never throws. Nothing here is worth failing a compile that has just produced
 * a good PDF, and a delete that does not happen is retried on the next save.
 */
async function pruneRenders(root: string, justSaved: string): Promise<void> {
  try {
    const limit = keepLimit();
    if (limit === 0) return;
    const dir = join(root, '.latex-preview', 'renders');
    const names = await readdir(dir).catch(() => [] as string[]);
    const artifacts = names.map((name) => ARTIFACT_RE.exec(name)).filter((m): m is RegExpExecArray => m !== null);
    if (artifacts.length <= limit) return;

    const { env } = await historyRepo(root);
    const success = (await gitOrNull(root, ['rev-parse', '--verify', '-q', SUCCESS_REF], env))?.trim();
    const keep = new Set([justSaved, ...(success ? [success] : [])]);

    const dated = await Promise.all(artifacts.map(async (match) => ({
      name: match[0],
      sha: match[1],
      at: await stat(join(dir, match[0])).then((info) => info.mtimeMs, () => 0),
    })));
    // Name as the tiebreak: two renders written in the same millisecond must
    // still order deterministically, or a rerun deletes a different pair.
    dated.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));

    for (const artifact of dated.slice(limit)) {
      if (keep.has(artifact.sha)) continue;
      await rm(join(dir, artifact.name), { force: true }).catch(() => {});
      await rm(join(dir, `${artifact.sha}.json`), { force: true }).catch(() => {});
    }
  } catch {
    /* a full disk, a locked file, no history store — none of them is this
       function's problem to report, and none is worth a failed compile */
  }
}

async function assertReachable(root: string, sha: string): Promise<void> {
  if (!SHA_RE.test(sha)) throw new Error('invalid checkpoint id');
  const { env } = await historyRepo(root);
  if ((await gitOrNull(root, ['merge-base', '--is-ancestor', sha, REF], env)) === null) throw new Error('unknown checkpoint');
}

export async function readRenderArtifact(root: string, sha: string): Promise<Buffer | null> {
  await assertReachable(root, sha);
  try { return await readFile(renderArtifactPath(root, sha)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readRenderMetadata(root: string, sha: string): Promise<RenderMetadata | null> {
  await assertReachable(root, sha);
  try { return JSON.parse(await readFile(metadataPath(root, sha), 'utf8')) as RenderMetadata; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
