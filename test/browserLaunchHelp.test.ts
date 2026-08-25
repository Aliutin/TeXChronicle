// Playwright installs no browser of its own (1.62 has no postinstall hook), so
// TeXChronicle downloads one from its own postinstall and again on first use.
// This message is what is left when both of those were skipped or failed: without
// it the first show_diff / wasm compile fails with Playwright's own terminal-shaped
// ASCII box, which relayed through MCP reaches the reader as box-drawing characters
// around a command that is not the one they need, so browserHost maps it to the
// one that is — plus the way out for a machine that cannot download at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLaunchHelp } from '../src/engine/browserHost.js';

// The real thing, as playwright prints it.
const MISSING_BROWSER = `browserType.launch: Executable doesn't exist at C:\\Users\\a\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-win\\headless_shell.exe
╔═════════════════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.                    ║
║ Please run the following command to download new browsers:              ║
║                                                                         ║
║     npx playwright install                                              ║
║                                                                         ║
║ <3 Playwright Team                                                      ║
╚═════════════════════════════════════════════════════════════════════════╝`;

test('a missing browser is turned into the command that installs it', () => {
  const help = browserLaunchHelp(new Error(MISSING_BROWSER));
  assert.ok(help, 'the missing-executable error must be recognised');
  assert.match(help, /Playwright's Chromium and it is not installed/);
  assert.match(help, /npx --no-install playwright install chromium --only-shell/);
  assert.match(help, /in the TeXChronicle folder, then restart your MCP client\./);
  // Offline, or behind a proxy that blocks the CDN, that command cannot work —
  // so the message has to name the way out that needs no download at all.
  assert.match(help, /TEXCHRONICLE_BROWSER/);
  assert.match(help, /"chrome", "msedge", or the full path/);
  // The point of the wrap is that the box never reaches the reader.
  assert.doesNotMatch(help, /[╔╝║═]/);
  assert.doesNotMatch(help, /Looks like Playwright/);
});

test('the match does not depend on the exact casing playwright uses', () => {
  assert.ok(browserLaunchHelp(new Error("EXECUTABLE DOESN'T EXIST at /nowhere")));
});

test('a plain string error is handled as well as an Error', () => {
  assert.ok(browserLaunchHelp("Executable doesn't exist at /nowhere"));
});

test('every other launch failure is left alone for its own message to show', () => {
  assert.equal(browserLaunchHelp(new Error('browserType.launch: Target page, context or browser has been closed')), null);
  assert.equal(browserLaunchHelp(new Error('spawn EACCES')), null);
  assert.equal(browserLaunchHelp(undefined), null);
});
