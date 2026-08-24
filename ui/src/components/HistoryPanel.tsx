// History has two projections over the same hidden Git checkpoint chain:
// semantic section timelines (the default) and the original whole-project log.
import { useEffect, useMemo, useState } from 'react';
import {
  fetchCheckpoints,
  fetchDiff,
  fetchGitStatus,
  fetchSectionDiff,
  fetchSectionHistory,
  restoreCheckpoint,
  restoreFile,
  restoreSection,
  type Checkpoint,
  type HistoryMode,
  type Status,
  type SectionHistoryPayload,
  type SectionVersion,
} from '../api';
import { DiffView } from './DiffView';

type HistoryView = 'sections' | 'project';

export interface HistorySelection {
  key: string;
  sha: string;
  title: string;
  subtitle: string;
  hasPdf: boolean;
}

export interface HistoryDiffDetail extends HistorySelection {
  diff: string;
  loading: boolean;
}

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return iso; }
};

const changeText = (version: SectionVersion): string => version.changes.map((change) => ({
  created: 'created', edited: 'text', renamed: 'renamed', moved: 'moved', reordered: 'reordered', structure: 'structure', descendant: 'subsection',
}[change])).join(' · ');

export function HistoryPanel({
  reloadTick,
  onPreviewVersion,
  showInlineDiff = true,
  onSelectionChange,
  onDiffChange,
  liveStatus,
}: {
  reloadTick: number;
  onPreviewVersion?: (sha: string, title: string) => void;
  showInlineDiff?: boolean;
  onSelectionChange?: (selection: HistorySelection) => void;
  onDiffChange?: (detail: HistoryDiffDetail) => void;
  liveStatus?: Status;
}) {
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [mode, setMode] = useState<HistoryMode | null>(null);
  const [view, setView] = useState<HistoryView>('sections');
  const [items, setItems] = useState<Checkpoint[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [semantic, setSemantic] = useState<SectionHistoryPayload | null>(null);
  const [semanticError, setSemanticError] = useState('');
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [sectionDiff, setSectionDiff] = useState('');
  const [includeSubsections, setIncludeSubsections] = useState(false);
  const [busy, setBusy] = useState(false);

  const section = useMemo(
    () => semantic?.sections.find((candidate) => candidate.id === selectedSection) ?? null,
    [semantic, selectedSection],
  );
  const version = useMemo(
    () => section?.versions.find((candidate) => candidate.sha === selectedVersion) ?? null,
    [section, selectedVersion],
  );
  const versionIndex = useMemo(
    () => section?.versions.findIndex((candidate) => candidate.sha === selectedVersion) ?? -1,
    [section, selectedVersion],
  );
  const activeSelection = useMemo<HistorySelection | null>(() => {
    if (view === 'sections' && section && version) {
      return {
        key: `section:${section.id}:${version.versionId}`,
        sha: version.sha,
        title: section.title,
        subtitle: `${fmt(version.time)} · ${version.path}:${version.startLine}`,
        hasPdf: version.hasPdf,
      };
    }
    if (view === 'project' && selected) {
      const checkpoint = items.find((candidate) => candidate.sha === selected);
      if (checkpoint) {
        return {
          key: `project:${checkpoint.sha}`,
          sha: checkpoint.sha,
          title: 'Whole-project checkpoint',
          subtitle: fmt(checkpoint.time),
          hasPdf: false,
        };
      }
    }
    return null;
  }, [items, section, selected, version, view]);

  const selectSectionVersion = (candidate: SectionVersion) => {
    setSelectedVersion(candidate.sha);
  };

  const selectVersionAt = (index: number) => {
    const candidate = section?.versions[index];
    if (candidate) selectSectionVersion(candidate);
  };

  const restoreProject = async (sha: string) => {
    if (!confirm('Restore the project to this version? Your current text is snapshotted first, so you can undo this.')) return;
    setBusy(true);
    const error = await restoreCheckpoint(sha);
    setBusy(false);
    if (error) alert(error);
  };

  const restoreSemantic = async () => {
    if (!section || !version) return;
    if (!confirm(`Restore “${section.title}” and its subsections to ${fmt(version.time)}? Your current files are snapshotted first, so this is reversible.`)) return;
    setBusy(true);
    const error = await restoreSection(section.id, version.sha);
    setBusy(false);
    if (error) alert(error);
  };

  useEffect(() => { fetchGitStatus().then((status) => { setIsRepo(status.isRepo); setMode(status.mode); }); }, []);

  useEffect(() => {
    if (isRepo === false) return;
    let cancelled = false;
    fetchCheckpoints().then((list) => {
      if (cancelled) return;
      setItems(list);
      setSelected((current) => list.some((checkpoint) => checkpoint.sha === current) ? current : list[0]?.sha ?? null);
    });
    setSemanticError('');
    fetchSectionHistory().then((history) => {
      if (cancelled) return;
      setSemantic(history);
      setSelectedSection((current) => history.sections.some((candidate) => candidate.id === current)
        ? current
        : history.sections.find((candidate) => candidate.present)?.id ?? history.sections[0]?.id ?? null);
    }).catch((error) => { if (!cancelled) setSemanticError(String(error?.message ?? error)); });
    return () => { cancelled = true; };
  }, [reloadTick, isRepo]);

  useEffect(() => {
    if (!section?.versions.length) { setSelectedVersion(null); return; }
    setSelectedVersion((current) => section.versions.some((candidate) => candidate.sha === current)
      ? current
      : section.versions[0].sha);
  }, [section]);

  useEffect(() => {
    if (activeSelection) onSelectionChange?.(activeSelection);
  }, [activeSelection, onSelectionChange]);

  useEffect(() => {
    if (view !== 'project' || !selected || !activeSelection) { if (view === 'project') setDiff(''); return; }
    let cancelled = false;
    setDiff('');
    onDiffChange?.({ ...activeSelection, diff: '', loading: true });
    fetchDiff(selected).then((result) => {
      if (cancelled) return;
      setDiff(result);
      onDiffChange?.({ ...activeSelection, diff: result, loading: false });
    });
    return () => { cancelled = true; };
  }, [activeSelection, onDiffChange, selected, view]);

  useEffect(() => {
    if (view !== 'sections' || !selectedSection || !selectedVersion || !activeSelection) {
      if (view === 'sections') setSectionDiff('');
      return;
    }
    let cancelled = false;
    setSectionDiff('');
    onDiffChange?.({ ...activeSelection, diff: '', loading: true });
    fetchSectionDiff(selectedSection, selectedVersion, includeSubsections)
      .then((result) => {
        if (cancelled) return;
        setSectionDiff(result.diff);
        onDiffChange?.({ ...activeSelection, diff: result.diff, loading: false });
      })
      .catch((error) => {
        if (cancelled) return;
        const failure = `diff --git a/section b/section\n@@ -1 +1 @@\n-${String(error?.message ?? error)}\n`;
        setSectionDiff(failure);
        onDiffChange?.({ ...activeSelection, diff: failure, loading: false });
      });
    return () => { cancelled = true; };
  }, [activeSelection, includeSubsections, onDiffChange, selectedSection, selectedVersion, view]);

  if (isRepo === false) {
    return (
      <div className="panel-hint">
        History needs <code>git</code>, and none was found on your PATH. Install it
        from <a href="https://git-scm.com/" target="_blank" rel="noreferrer">git-scm.com</a> and
        restart. No account or remote is required.
      </div>
    );
  }
  if (!items.length) {
    const message = liveStatus === 'compiling'
      ? 'Initial compile in progress. The first PDF and History checkpoint will appear together after it succeeds.'
      : liveStatus === 'error'
        ? 'No successful compile yet. Fix the compile error, then the first successful PDF will create the first checkpoint automatically.'
        : 'Waiting for the first successful compile. Its source and exact PDF will become checkpoint 1 automatically.';
    return <div className="panel-hint">{message}</div>;
  }

  const baseLevel = semantic?.sections.filter((candidate) => candidate.present).reduce((min, candidate) => Math.min(min, candidate.level), 9) ?? 0;

  return (
    <div className={`history ${showInlineDiff ? '' : 'history-browser'}`}>
      {mode === 'shadow' && (
        <div className="history-note">
          Source history lives in <code>.latex-preview/history.git</code>; exact rendered PDFs live
          in <code>.latex-preview/renders</code>. Both move and Dropbox-sync with this folder.
        </div>
      )}
      <div className="history-mode seg">
        <button className={view === 'sections' ? 'on' : ''} onClick={() => setView('sections')}>Sections</button>
        <button className={view === 'project' ? 'on' : ''} onClick={() => setView('project')}>Whole project</button>
      </div>

      {view === 'sections' ? (
        <>
          {semanticError && <div className="panel-hint load-error">{semanticError}</div>}
          {!semanticError && semantic && !semantic.sections.length && (
            <div className="panel-hint">No <code>\section</code> or <code>\subsection</code> headings were found in the checkpoint history.</div>
          )}
          <div className="section-tree">
            {semantic?.sections.map((candidate) => (
              <button
                key={candidate.id}
                className={`section-row ${candidate.id === selectedSection ? 'sel' : ''} ${candidate.present ? '' : 'gone'}`}
                style={{ paddingLeft: 10 + Math.max(0, candidate.level - baseLevel) * 15 }}
                onClick={() => {
                  setSelectedSection(candidate.id);
                  const newest = candidate.versions[0];
                  if (newest) selectSectionVersion(newest);
                }}
                title={`${candidate.path}${candidate.label ? ` · ${candidate.label}` : ''}`}
              >
                <span className="section-kind">{candidate.appendix ? 'A' : candidate.command === 'section' ? '§' : '›'}</span>
                <span className="section-title">{candidate.title}</span>
                <span className="section-count">{candidate.versions.length}</span>
              </button>
            ))}
          </div>

          {section && (
            <div className="section-history-head">
              <div className="section-heading" title={section.path}>{section.title}</div>
              <div className="scope-toggle seg" title="Direct text ignores child subsection moves; subtree includes them">
                <button className={!includeSubsections ? 'on' : ''} onClick={() => setIncludeSubsections(false)}>Text</button>
                <button className={includeSubsections ? 'on' : ''} onClick={() => setIncludeSubsections(true)}>+ subsections</button>
              </div>
            </div>
          )}

          <div className="section-versions">
            {section?.versions.map((candidate, index) => (
              <div
                key={candidate.versionId}
                className={`section-version ${candidate.sha === selectedVersion ? 'sel' : ''}`}
                onClick={() => selectSectionVersion(candidate)}
                role="button"
                tabIndex={0}
                aria-pressed={candidate.sha === selectedVersion}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectSectionVersion(candidate);
                  }
                }}
              >
                <span className="version-node" aria-hidden="true" />
                <div className="version-main">
                  <div className="version-time">{fmt(candidate.time)}{index === 0 && section.present ? <span className="current-tag">current</span> : null}</div>
                  <div className="version-change">{changeText(candidate) || 'checkpoint'} · {candidate.path}:{candidate.startLine}</div>
                </div>
                {candidate.confidence === 'low' && <span className="confidence-low" title={`Fuzzy identity match score ${candidate.matchScore.toFixed(2)}`}>?</span>}
                {candidate.hasPdf && <span className="pdf-badge" title="Exact PDF is available">PDF</span>}
              </div>
            ))}
          </div>

          {version && (
            <div className="section-actions">
              <div className="version-stepper" aria-label="Browse section versions in order">
                <button
                  disabled={versionIndex <= 0}
                  onClick={() => selectVersionAt(versionIndex - 1)}
                  title="Show the next newer version"
                >
                  ← newer
                </button>
                <span className="version-position" aria-live="polite">
                  {versionIndex + 1} / {section?.versions.length ?? 0}
                </span>
                <button
                  disabled={versionIndex < 0 || versionIndex >= (section?.versions.length ?? 0) - 1}
                  onClick={() => selectVersionAt(versionIndex + 1)}
                  title="Show the next older version"
                >
                  older →
                </button>
              </div>
              <span className="spacer" />
              <button disabled={!version.hasPdf} onClick={() => onPreviewVersion?.(version.sha, version.title)} title={version.hasPdf ? 'Show the exact PDF produced for this version' : 'This checkpoint predates stored PDF artifacts'}>
                Show PDF
              </button>
              <button disabled={busy || Boolean(section?.present && version.versionId === section.versions[0]?.versionId)} onClick={() => void restoreSemantic()} title="Restore only this section and its subsections; current state is checkpointed first">
                ↩ restore section
              </button>
            </div>
          )}
          {showInlineDiff
            ? (sectionDiff ? <DiffView diff={sectionDiff} /> : <div className="panel-hint">Select a section version to see its own changes.</div>)
            : <div className="history-side-hint">The precise code difference is shown in the large pane on the right.</div>}
        </>
      ) : (
        <>
          <div className="history-list">
            {items.map((checkpoint, index) => (
              <div key={checkpoint.sha} className={`ck ${checkpoint.sha === selected ? 'sel' : ''}`} onClick={() => setSelected(checkpoint.sha)}>
                <div className="ck-t">
                  {fmt(checkpoint.time)}
                  {index > 0 && (
                    <button className="ck-restore" disabled={busy} title="Restore the project to this version (reversible)"
                            onClick={(event) => { event.stopPropagation(); void restoreProject(checkpoint.sha); }}>
                      ↩ restore
                    </button>
                  )}
                </div>
                <div className="ck-s">
                  {checkpoint.filesChanged} file{checkpoint.filesChanged === 1 ? '' : 's'}
                  {checkpoint.insertions > 0 && <span className="add"> +{checkpoint.insertions}</span>}
                  {checkpoint.deletions > 0 && <span className="del"> −{checkpoint.deletions}</span>}
                </div>
              </div>
            ))}
          </div>
          {showInlineDiff && diff ? (
            <DiffView
              diff={diff}
              onRevertFile={selected ? async (file) => {
                if (!confirm(`Revert “${file}” to this version? Only this file changes; current state is snapshotted first.`)) return;
                setBusy(true);
                const error = await restoreFile(selected, file);
                setBusy(false);
                if (error) alert(error);
              } : undefined}
            />
          ) : showInlineDiff
            ? <div className="panel-hint">Select a checkpoint to see its diff.</div>
            : <div className="history-side-hint">The project code difference is shown in the large pane on the right.</div>}
        </>
      )}
    </div>
  );
}
