// The one source of truth for "which project are we previewing". Set by the
// coordinator on each render_preview; read by the git endpoints. A tiny standalone
// module (no imports) so the coordinator and preview server can share it without
// an import cycle.
//
// cwd is only the last-resort default. The MCP server overwrites it at startup
// with src/projectRoot.ts's answer (--project, then $TEXCHRONICLE_PROJECT, then
// cwd), because cwd is right only for the clients that spawn a server inside the
// project — which is not all of them.
let projectRoot = process.cwd();

export function setProjectRoot(root: string): void { projectRoot = root; }
export function getProjectRoot(): string { return projectRoot; }
