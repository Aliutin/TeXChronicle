// `vite build ui`, but tolerant of a folder synchroniser.
//
// Vite empties ui/dist before writing. When the checkout lives in Dropbox or
// OneDrive, the synchroniser opens the files it just saw appear, and for a
// second or two `rmSync` on them fails with EPERM/EBUSY — which is exactly
// what happened the first time `npm publish` ran here, because npm builds the
// UI once for `prepare` and once for `prepublishOnly`, back to back. The
// double build is gone (prepare alone covers publish), but a single build can
// still land on a lock, so retry a few times before giving up.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ATTEMPTS = 6;
const LOCK_SIGNS = /EPERM|EBUSY|ENOTEMPTY|Permission denied|operation not permitted/i;

const vite = join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const run = spawnSync(process.execPath, [vite, 'build', 'ui'], { cwd: REPO, encoding: 'utf8' });
  process.stdout.write(run.stdout ?? '');
  if (run.status === 0) process.exit(0);
  const err = run.stderr ?? '';
  const locked = LOCK_SIGNS.test(err) || LOCK_SIGNS.test(run.stdout ?? '');
  if (!locked || attempt === ATTEMPTS) { process.stderr.write(err); process.exit(run.status ?? 1); }
  process.stderr.write(`[texchronicle] ui/dist was locked by another program (a folder synchroniser, most likely) — retrying the UI build in ${attempt}s (${attempt}/${ATTEMPTS - 1})…\n`);
  sleep(attempt * 1000);
}
