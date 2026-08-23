// The single MCP tool this server exposes. Git history/diffing is intentionally
// NOT a tool here — Claude Code's native Bash already covers it.
import { z } from 'zod';

export const RENDER_PREVIEW_NAME = 'render_preview';

export const renderPreviewInputSchema = {
  mainFile: z
    .string()
    .optional()
    .describe('Path to the main .tex file, relative to the project root. Auto-detected (by scanning for \\documentclass) if omitted.'),
  engine: z
    .enum(['pdflatex', 'xelatex', 'lualatex'])
    .optional()
    .describe('TeX engine. Auto-detected from editor directives and the preamble when omitted; ordinary documents default to pdflatex.'),
  shellEscape: z
    .boolean()
    .optional()
    .describe('Let the document run external programs (LaTeX shell-escape) — needed by \\includesvg (Inkscape), minted (Pygments) and similar. Off by default: it lets a .tex execute shell commands, so enable it only for sources you trust. Has no effect on the wasm backend, which cannot run subprocesses at all.'),
  backend: z
    .enum(['wasm', 'system', 'auto'])
    .optional()
    .describe('Compiler backend. Default "auto": use the local TeX install (latexmk) when there is one — full package fidelity, output matching Overleaf — else the bundled WASM TeX Live. "system" forces the local one and errors if absent; "wasm" forces the bundled one.'),
};

export const renderPreviewConfig = {
  title: 'Render LaTeX preview',
  description:
    'Compile the current project\'s LaTeX to a PDF locally and update the live preview. Uses the machine\'s TeX install when it has one, otherwise a bundled WASM TeX Live in a headless browser — so no local TeX is required. Returns compile success/errors, which engine and backend ran, the file count, and the local preview URL — open it to see the rendered pages. Call this after editing .tex files to see and verify the rendered result.',
  inputSchema: renderPreviewInputSchema,
};
