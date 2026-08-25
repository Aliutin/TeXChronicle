---
description: render_preview tool — compile this paper and open the live preview
---

Call the `render_preview` MCP tool to compile the current LaTeX project and open
the TeXChronicle live preview. If the preview is already running this recompiles and
refreshes it. When it finishes, tell me the workspace URL and the page count, and
remind me I can select text on the PDF to leave comments.

If it answers that the folder does not look like a LaTeX project, the server was
started somewhere other than the paper — call it again with `projectRoot` set to
the paper's absolute path rather than telling me to edit my MCP config. That
choice sticks for the rest of the session.
