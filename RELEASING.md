# Releasing

Four steps. They used to live only as habit, and 0.1.9 shipped with two of them
missed — the notes were never committed, and the MCP registry was left pointing
at 0.1.8, so anyone installing from there got a version without the data-loss
fixes. Nothing would have surfaced that; you have to go and look.

So every step below ends with a check. **The checks are the point.** A missed
publish looks exactly like a successful one from here.

Versions are semver: a patch on `0.1.9` is `0.1.10`, never `0.1.9.1`.

---

## The first release under the new name (one time)

Steps 0–5 below are the standing procedure. This list is the one-off that gets
`texchronicle` onto GitHub and npm for the first time; it points at those steps
where they overlap. Today `github.com/Aliutin/TeXChronicle` **exists but is
empty**, and `npm view texchronicle` is a 404 — so nothing in the docs works for
anyone else until item 1.

1. **Push, and merge to `main`.** The empty repository is what every documented
   install route depends on: `npx -y github:Aliutin/TeXChronicle`,
   `/plugin marketplace add Aliutin/TeXChronicle`, and the plugin's own bundled
   server entry all resolve the default branch. Push the working branch, open the
   PR, merge it.

   **Check:** `git ls-remote https://github.com/Aliutin/TeXChronicle.git` lists
   refs (it prints nothing at all while the repository is empty), and on a machine
   with no clone, `npx -y github:Aliutin/TeXChronicle --help` prints the CLI help.
   That second one is the real check — it exercises the clone, the devDependency
   install, and the `prepare` build the way a stranger's machine will.

2. **Run step 0's checks on `main`** — unit suite, UI build, and the three browser
   smokes. Nothing about the rename skips them.

3. **`npm login`.** Use the account that owns `magictex-mcp`, so item 5 can
   deprecate it. `texchronicle` is unclaimed on the registry today.

   **Check:** `npm whoami`.

4. **`npm publish`** (add `--otp=<code>` if 2FA is on). `prepublishOnly` rebuilds
   `ui/dist` first, so no manual build is needed. The `postinstall` step that
   downloads Playwright's Chromium does **not** run here — it runs on the
   consumer's machine at install time, which is exactly what makes the published
   tarball small and the first `npx texchronicle` slow.

   **Check:** `npm view texchronicle version`, and `npm pack --dry-run` beforehand
   for `ui/dist` (see step 1 below — it is gitignored, and if `prepublishOnly`
   stops firing the workspace ships empty with nothing else noticing).

5. **Deprecate the old package.**

   ```bash
   npm deprecate magictex-mcp "Renamed to texchronicle"
   ```

   Existing versions stay installable — this only adds the warning that tells
   people where the project went.

   **Check:** `npm view magictex-mcp deprecated`.

6. **Publish to the MCP registry** exactly as in step 3 below. `server.json` is
   already correct for this release: `io.github.Aliutin/texchronicle`, version
   `0.1.12` in both places, npm identifier `texchronicle`. Log in first; the token
   from the previous release has expired.

7. **Flip the docs off the GitHub route.** Until the publish, the install route
   documented everywhere is `github:Aliutin/TeXChronicle`. Once `npm view
   texchronicle version` answers, change:

   - `.mcp.json.example` → `"command": "npx", "args": ["-y", "texchronicle"]`
   - `.claude-plugin/plugin.json` (`mcpServers.texchronicle.args`) → the same
   - `README.md` — "Setup with an LLM/MCP client" (lead with the npm form, keep
     the source checkout as the developer alternative), "Terminal launch", and the
     plugin section's "until the npm release" sentence
   - `docs/USER-GUIDE.md` — the `.mcp.json` line in "Everyday use"
   - `CONTRIBUTING.md` — the "until the npm release" paragraph
   - `docs/i18n/README.*.md` — delete the seven one-line "Not on npm yet" notices

   **Check:** `grep -rn "github:Aliutin/TeXChronicle" --exclude-dir=node_modules
   --exclude-dir=.git .` returns nothing but this file and
   `.github/ISSUE_TEMPLATE/bug_report.yml` — the bug report keeps its mention on
   purpose, because installing from GitHub stays a real way to run TeXChronicle
   and a reporter who did that still has to say so.

8. **Tag and release**, then **verify what you published** — steps 4 and 5 below,
   unchanged.

---

## 0. Before you start

Everything being released is already merged into `main`, and `main` is green.

```bash
git checkout main && git pull --ff-only
npm test                    # unit
npm run build:ui
```

Run the browser smokes too, at least `compile`, `history` and
`editor-keeps-text` — they drive a real headless browser and cover what the unit
tests cannot:

```bash
node scripts/smoke-compile.mjs
node scripts/smoke-history.mjs
node scripts/smoke-editor-keeps-text.mjs
```

`.gitattributes` now pins line endings with `* text=auto`. If a checkout shows
files as modified with no visible change, run `git add --renormalize .` once and
commit that on its own — a one-time correction to what the index recorded before
the rule existed, not something a release needs again.

## 1. Write the notes, bump the version

`RELEASE-<version>.md` at the repo root. Its body becomes the GitHub release, so
write it for someone deciding whether to upgrade: what broke, how it was
measured, and what you got wrong on the way.

**It is deliberately gitignored** (`/RELEASE-*.md`) — the notes live on the
release page, not in the tree. So `git add -A` silently skips it, and a PR that
claims to have added one has not: that happened while writing this file, and the
claim went into a PR description before anyone noticed. It is a scratch file that
step 4 reads; nothing else should expect to find it in a clone.

Bump the version in **four** files — they must agree, and `server.json` carries
it twice:

- `package.json`
- `package-lock.json` (twice: top level and `packages.""`)
- `server.json` (twice: `version` and `packages[0].version`)
- `.claude-plugin/plugin.json`

Open this as its own `release/<version>` PR. The `pr-links-issue` check has no
issue to find, so open the body with a line like:

```
exempt: release PR — cuts <version> from work already merged under #NN, #NN.
```

**Check** before merging:

```bash
npm pack --dry-run           # right filename, ui/dist present, nothing stray
```

`ui/dist` is gitignored and built by `prepublishOnly`. If it is missing from the
tarball, the workspace ships empty and nothing else in this list would notice.

## 2. Publish to npm

```bash
npm publish                  # add --otp=<code> if 2FA is on
```

`prepublishOnly` rebuilds `ui/dist` first, so no manual build is needed.

**Check:**

```bash
npm view texchronicle version
```

## 3. Publish to the MCP registry

This is the step that was missed in 0.1.9. `server.json` is not published by
`npm publish` — it goes to the official registry separately, with
`mcp-publisher` (https://github.com/modelcontextprotocol/registry), which lives
at the repo root and is gitignored.

```powershell
.\mcp-publisher.exe login github     # device code; the token expires between releases
.\mcp-publisher.exe publish
```

The `io.github.Aliutin/*` namespace authenticates against the matching GitHub
account. **Log in first.** The token from the previous release will have expired,
and the failure is not obvious:

```
Error: publish failed: server returned status 401:
  "Invalid or expired Registry JWT token" ... "token is expired"
```

If a `publish` returns 401, check the registry before re-running. In 0.1.10 the
publish had already succeeded and the 401 came afterwards; logging in and
retrying then returned `400 cannot publish duplicate version`, which reads like
a new problem and is actually the confirmation.

**Check — and read `isLatest`, not the newest timestamp:**

```powershell
(Invoke-RestMethod "https://registry.modelcontextprotocol.io/v0/servers?search=texchronicle&limit=100").servers |
  % { [pscustomobject]@{ v = $_.server.version; latest = $_._meta.'io.modelcontextprotocol.registry/official'.isLatest } }
```

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=texchronicle&limit=100" \
  | grep -o '"version":"[^"]*"' | tail -3
```

The entry flagged `isLatest` must be the version you just published. Sorting the
list by `publishedAt` and taking the last one is *not* the same check — a freshly
published version can be missing from the search index for a while, so that
method reported the previous release as current minutes after 0.1.10 went up.

## 4. Tag and create the GitHub release

```bash
git tag -a v<version> -m "v<version>"
git push origin v<version>
gh release create v<version> --title "v<version>" --notes-file RELEASE-<version>.md --latest
```

**Check:** `gh release list` shows it as `Latest`.

## 5. Verify what you published, not what you built

Everything up to here tested the working tree. This tests the artifact users
actually install — a clean install from the registry, driven through the real MCP
protocol:

```bash
npm install --prefix /tmp/verify texchronicle@<version>
```

then run `bin/cli.mjs` from that prefix against a scratch project and call
`render_preview`. Point `TEXCHRONICLE_ASSETS_DIR` at assets you already have so this
does not re-download 480 MB. (Either separator works from 0.1.10 on; before that
a forward-slash path was refused outright, which is what #84 was.)

Assert four things, because each has been wrong at least once: the package
installs, `ui/dist` is in the tarball, the server answers MCP, and a real
document compiles.

`ui/dist` is the one to keep: it is gitignored and built by `prepublishOnly`, so
if that hook ever stops firing the workspace ships empty and every other check
here still passes.

This step is not decoration. It is how #84 was found, half an hour after 0.1.9
went out.
