# Security policy

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Use GitHub's private reporting instead:
[**Report a vulnerability**](https://github.com/Aliutin/TeXChronicle/security/advisories/new)
(Security tab → Report a vulnerability). That opens a private thread only you
and I can see.

I'm one person, not a company — expect a reply within about a week, not within
hours.

## What's in scope

TeXChronicle runs **entirely on your own machine**. There's no TeXChronicle cloud server, no
account, and your paper is never uploaded anywhere. That shapes what counts as
a vulnerability here:

**In scope**
- Path traversal in the file APIs (`/api/file`, `/api/tree`, `/api/upload`) —
  anything that reads or writes outside the project root.
- The preview server binding to something other than `127.0.0.1`, or otherwise
  becoming reachable from the network.
- Command injection through the git plumbing (`src/git/`) — e.g. a crafted
  branch name or checkpoint sha reaching a shell.
- Anything that lets a compiled `.tex` file escape the WASM engine sandbox and
  touch the host.
- The checkpoint system writing to the user's real branches, index, or working
  tree (it must only ever touch `refs/latex-preview/checkpoints`).

**Out of scope**
- The preview server being reachable from other processes on your own machine.
  It's a localhost dev server; that's expected.
- LaTeX packages that fail to compile, or output that differs from Overleaf.
  See the package-coverage section of [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md).
- An AI agent making a bad edit to your paper. That's what the human gate and
  the checkpoint history are for — see [`docs/AGENT-LOOP.md`](docs/AGENT-LOOP.md).

## Supported versions

Only the latest published version gets fixes. This project is pre-1.0 and
moving; there are no backported patches.
