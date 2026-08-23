// Overleaf-style file tree: nested folders + editable files, with new file /
// new folder / rename / delete. Click a file to open it in the editor.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTree, fsOp, uploadFile, type TreeNode } from '../api';

export function FileTree({
  active, onOpen, refreshKey, height, dirtyPaths,
}: {
  active: string | null;
  onOpen: (path: string) => void;
  /** Files holding unsaved edits — including ones not currently open. Without a
   *  marker, parking a buffer on a file switch is just a quieter way to lose it:
   *  the user has no way to know the text is still there, waiting. */
  dirtyPaths?: Set<string>;
  refreshKey: number; // bump to reload the tree (e.g. after external edits)
  /** Split view uses a fixed, draggable height; focused source views fill a sidebar. */
  height?: number;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const treeBody = useRef<HTMLDivElement>(null);
  const uploadDir = useRef<string>(''); // folder to upload into (root by default)

  const reload = useCallback(async () => {
    const t = await fetchTree().catch(() => []);
    if (t.length) { setTree(t); return; }
    // Fallback for an older server without /api/tree: show the flat file list.
    try {
      const files: string[] = await (await fetch('/api/files')).json();
      setTree(files.map((f) => ({ name: f.split('/').pop() ?? f, path: f, type: 'file' as const })));
    } catch { setTree([]); }
  }, []);
  useEffect(() => { reload(); }, [reload, refreshKey]);
  // Keep large projects calm: folders start collapsed, but a file opened by a
  // PDF jump (or another part of the UI) reveals its ancestor chain.
  useEffect(() => {
    if (!active?.includes('/')) return;
    const parts = active.split('/');
    const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    setOpen((current) => {
      if (ancestors.every((path) => current[path])) return current;
      const next = { ...current };
      for (const path of ancestors) next[path] = true;
      return next;
    });
  }, [active]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      treeBody.current?.querySelector('.tree-row.on')?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, open]);

  const doOp = async (op: string, path: string, to?: string) => {
    const e = await fsOp(op, path, to);
    if (e) { setErr(e); setTimeout(() => setErr(null), 4000); return false; }
    reload();
    return true;
  };

  // Create in a folder (or root). Prompt is the simplest reliable affordance here.
  const newFile = async (dir: string) => {
    const name = prompt(`New file name in ${dir || 'project root'} (e.g. sections/intro.tex):`);
    if (name) { const path = dir ? `${dir}/${name}` : name; if (await doOp('mkfile', path)) onOpen(path); }
  };
  const newFolder = async (dir: string) => {
    const name = prompt(`New folder name in ${dir || 'project root'}:`);
    if (name) await doOp('mkdir', dir ? `${dir}/${name}` : name);
  };
  const rename = async (node: TreeNode) => {
    const to = prompt('Rename to (path relative to project root):', node.path);
    if (to && to !== node.path) await doOp('rename', node.path, to);
  };
  const del = async (node: TreeNode) => {
    if (confirm(`Delete ${node.type === 'dir' ? 'folder' : 'file'} "${node.path}"?${node.type === 'dir' ? ' All contents will be removed.' : ''}`)) {
      await doOp('delete', node.path);
    }
  };

  const pickUpload = (dir: string) => { uploadDir.current = dir; uploadInput.current?.click(); };
  const onUpload = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const path = uploadDir.current ? `${uploadDir.current}/${f.name}` : f.name;
      const e = await uploadFile(path, f);
      if (e) { setErr(e); setTimeout(() => setErr(null), 4000); }
    }
    if (uploadInput.current) uploadInput.current.value = '';
    reload();
  };

  const Row = ({ node, depth }: { node: TreeNode; depth: number }) => {
    const isOpen = open[node.path] ?? false;
    return (
      <>
        <div
          className={`tree-row ${node.type} ${node.editable === false ? 'asset' : ''} ${node.path === active ? 'on' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => node.type === 'dir' ? setOpen((o) => ({ ...o, [node.path]: !isOpen })) : node.editable !== false && onOpen(node.path)}
          title={node.editable === false ? `${node.path} (figure — not editable here)` : node.path}
        >
          <span className="tree-caret">{node.type === 'dir' ? (isOpen ? '▾' : '▸') : ''}</span>
          <span className="tree-icon">{node.type === 'dir' ? '📁' : node.editable === false ? '🖼' : '📄'}</span>
          <span className="tree-name">{node.name}</span>
          {dirtyPaths?.has(node.path) && (
            <span className="tree-dirty" title="unsaved changes — still here, not yet on disk">•</span>
          )}
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            {node.type === 'dir' && <button title="New file here" onClick={() => newFile(node.path)}>+</button>}
            {node.type === 'dir' && <button title="Upload here" onClick={() => pickUpload(node.path)}>⬆</button>}
            <button title="Rename" onClick={() => rename(node)}>✎</button>
            <button title="Delete" onClick={() => del(node)}>🗑</button>
          </span>
        </div>
        {node.type === 'dir' && isOpen && node.children?.map((c) => <Row key={c.path} node={c} depth={depth + 1} />)}
      </>
    );
  };

  return (
    <div className="file-tree" style={height === undefined
      ? { height: '100%', flex: '1 1 auto' }
      : { height, flex: '0 0 auto' }}>
      <div className="tree-head">
        <span>Files</span>
        <span className="spacer" />
        <button title="New file" onClick={() => newFile('')}>＋ File</button>
        <button title="New folder" onClick={() => newFolder('')}>＋ Folder</button>
        <button title="Upload figures/assets" onClick={() => pickUpload('')}>⬆ Upload</button>
      </div>
      <input
        ref={uploadInput} type="file" multiple hidden
        accept=".png,.jpg,.jpeg,.gif,.pdf,.eps,.svg,.tex,.bib,.cls,.sty,.bst"
        onChange={(e) => void onUpload(e.target.files)}
      />
      {err && <div className="panel-hint load-error">{err}</div>}
      <div className="tree-body" ref={treeBody}>
        {tree.map((n) => <Row key={n.path} node={n} depth={0} />)}
        {tree.length === 0 && <div className="panel-hint">No files yet.</div>}
      </div>
    </div>
  );
}
