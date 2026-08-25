// Playwright installs no browser of its own (1.62 has no postinstall hook), so a
// plain `npm install` leaves the first show_diff / wasm compile failing with
// Playwright's own terminal-shaped ASCII box. Relayed through MCP that reaches
// the reader as box-drawing characters around a command that is not the one they
// need, so browserHost maps it to the one that is.
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
