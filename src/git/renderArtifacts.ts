import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { historyRepo } from './historyRepo.js';
import { gitOrNull } from './exec.js';

const REF = 'refs/latex-preview/checkpoints';
const SHA_RE = /^[0-9a-f]{7,64}$/;

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
  if (await exists(dest)) return; // repeated compile of unchanged source

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
