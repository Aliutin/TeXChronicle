#!/usr/bin/env node
// npm bin launcher. The server is TypeScript; register tsx's ESM loader in-process
// (no subprocess, so the MCP stdio channel is untouched), then start it.

// Check the Node version BEFORE importing anything, because the imports are what
// break. On an old Node this file failed inside tsx's own parsing, and an MCP
// client has no way to surface that — Claude Code shows a bare `-32000`, which
// says only "the server didn't start". A real user lost an hour to it: the cause
// was Node 12, and the first thing that ever said so out loud was an `npm install`
// warning buried in eighty lines of unrelated output.
//
// `engines` in package.json doesn't cover this: npm only warns, and never at run
// time. The floor is a real one — chokidar 5 needs >= 20.19.0 and playwright
// needs >= 20, so a Node 18 install would start fine and then silently stop
// live-reloading, which is worse than refusing to run.
//
// The floor is now READ from `engines` rather than restated here. It used to be
// two hardcoded numbers, and a later change added a second check in
// src/server.ts with a third — three floors, of which only this one could ever
// fire (ESM evaluates every `import` before a module body, so on an old Node
// chokidar throws long before src/server.ts reaches its own check).
//
// ./nodeVersion.mjs is written in old syntax on purpose and pulls in nothing, so
// static-importing it here is safe on the very Node versions being rejected.
import { readFileSync } from 'node:fs';
import { floorOf, isBelowFloor, tooOldMessage, exitWithMessage } from './nodeVersion.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const range = pkg.engines && pkg.engines.node;
if (isBelowFloor(process.versions.node, range)) {
  exitWithMessage(tooOldMessage(process.versions.node, floorOf(range)), 1);
} else {
  const { register } = await import('tsx/esm/api');
  register();

  const command = process.argv[2];
  if (command === 'preview' || command === 'open') {
    await import(new URL('../src/standalone.ts', import.meta.url).href);
  } else if (command === 'install-launcher') {
    try {
      const { installDesktopLauncher } = await import(new URL('../src/installLauncher.ts', import.meta.url).href);
      const paths = await installDesktopLauncher();
      console.log('[MagicTeX] Installed one-click launchers:');
      for (const path of paths) console.log(`  ${path}`);
      console.log('[MagicTeX] Click MagicTeX to reopen a recent paper or browse for a new .tex file; you can also drag a .tex file onto the desktop shortcut.');
    } catch (error) {
      console.error(`[MagicTeX] ${String(error && error.message || error)}`);
      process.exitCode = 1;
    }
  } else if (command === '--help' || command === '-h') {
    console.log(`MagicTeX — local LaTeX workspace and MCP server

Usage:
  magictex preview [main.tex] [options]   Open the standalone editor
  magictex open [main.tex] [options]      Open Recent projects when omitted
  magictex install-launcher               Add one-click shortcuts (Windows)
  magictex-mcp                            Start the MCP server on stdio

Run "magictex preview --help" for standalone options.`);
  } else if (command) {
    console.error(`Unknown command: ${command}\nRun "magictex --help" for usage.`);
    process.exitCode = 2;
  } else {
    // No arguments remains the MCP transport entry point, preserving every
    // existing Claude/Codex configuration.
    await import(new URL('../src/server.ts', import.meta.url).href);
  }
}
