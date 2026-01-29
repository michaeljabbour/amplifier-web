/**
 * Artifacts panel showing file changes made during the session.
 * Displays proper unified diffs with line numbers using react-diff-viewer.
 * Supports toggle between diff view and preview (final content) view.
 * Resizable, collapsible with smooth fly-in/out animation.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { useSessionStore } from '../../stores/sessionStore';
import { authFetch } from '../../stores/authStore';

interface Artifact {
  id: number;
  session_id: string;
  file_path: string;
  operation: 'create' | 'edit' | 'delete' | 'bash';
  content_before: string | null;
  content_after: string | null;
  diff: string | null;
  timestamp: string;
}

// Group artifacts by file path, keeping the latest state
interface FileState {
  filePath: string;
  artifacts: Artifact[];
  latestArtifact: Artifact;
  contentBefore: string;
  contentAfter: string;
  operation: 'create' | 'edit' | 'delete' | 'bash';
}

type ViewMode = 'diff' | 'preview';

// Custom styles for the diff viewer to match our dark theme
const diffViewerStyles = {
  variables: {
    dark: {
      diffViewerBackground: '#1a1a2e',
      diffViewerColor: '#e4e4e7',
      addedBackground: '#1e3a2f',
      addedColor: '#4ade80',
      removedBackground: '#3b1f1f',
      removedColor: '#f87171',
      wordAddedBackground: '#166534',
      wordRemovedBackground: '#7f1d1d',
      addedGutterBackground: '#14532d',
      removedGutterBackground: '#450a0a',
      gutterBackground: '#1f1f3a',
      gutterBackgroundDark: '#18182f',
      highlightBackground: '#2d2d4a',
      highlightGutterBackground: '#2d2d4a',
      codeFoldGutterBackground: '#1f1f3a',
      codeFoldBackground: '#1a1a2e',
      emptyLineBackground: '#1a1a2e',
      gutterColor: '#6b7280',
      addedGutterColor: '#4ade80',
      removedGutterColor: '#f87171',
      codeFoldContentColor: '#9ca3af',
      diffViewerTitleBackground: '#1f1f3a',
      diffViewerTitleColor: '#e4e4e7',
      diffViewerTitleBorderColor: '#374151',
    },
  },
  line: {
    padding: '2px 10px',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  gutter: {
    minWidth: '40px',
    padding: '0 8px',
    fontSize: '11px',
  },
  contentText: {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
};

function FileCard({ fileState, viewMode }: { fileState: FileState; viewMode: ViewMode }) {
  const [expanded, setExpanded] = useState(false);
  const filename = fileState.filePath.split('/').pop() || fileState.filePath;

  const operationColors = {
    create: 'text-green-400 bg-green-900/20',
    edit: 'text-yellow-400 bg-yellow-900/20',
    delete: 'text-red-400 bg-red-900/20',
    bash: 'text-blue-400 bg-blue-900/20',
  };

  const operationIcons = {
    create: '+',
    edit: '~',
    delete: '-',
    bash: '$',
  };

  const time = new Date(fileState.latestArtifact.timestamp).toLocaleTimeString();
  const editCount = fileState.artifacts.length;

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 p-2 hover:bg-gray-800/50 transition-colors text-left"
      >
        <span
          className={`w-6 h-6 rounded flex items-center justify-center text-sm font-bold ${operationColors[fileState.operation]}`}
        >
          {operationIcons[fileState.operation]}
        </span>
        <span className="flex-1 font-mono text-sm text-gray-200 truncate" title={fileState.filePath}>
          {filename}
        </span>
        {editCount > 1 && (
          <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded">
            {editCount} edits
          </span>
        )}
        <span className="text-xs text-gray-500">{time}</span>
        <span className="text-gray-500">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-700 bg-gray-900/50">
          <div className="text-xs text-gray-500 p-2 font-mono border-b border-gray-700/50">
            {fileState.filePath}
          </div>
          
          {viewMode === 'diff' ? (
            <div className="overflow-x-auto">
              {fileState.contentBefore || fileState.contentAfter ? (
                <ReactDiffViewer
                  oldValue={fileState.contentBefore}
                  newValue={fileState.contentAfter}
                  splitView={false}
                  useDarkTheme={true}
                  styles={diffViewerStyles}
                  compareMethod={DiffMethod.WORDS}
                  hideLineNumbers={false}
                  showDiffOnly={true}
                  extraLinesSurroundingDiff={3}
                />
              ) : (
                <div className="text-xs text-gray-500 italic p-4">No diff available</div>
              )}
            </div>
          ) : (
            <div className="max-h-96 overflow-auto">
              {fileState.contentAfter ? (
                <pre className="text-xs text-gray-300 p-3 font-mono whitespace-pre-wrap">
                  {fileState.contentAfter.split('\n').map((line, i) => (
                    <div key={i} className="flex">
                      <span className="select-none text-gray-600 w-10 text-right pr-3 flex-shrink-0">
                        {i + 1}
                      </span>
                      <span className="flex-1">{line}</span>
                    </div>
                  ))}
                </pre>
              ) : (
                <div className="text-xs text-gray-500 italic p-4">
                  {fileState.operation === 'delete' ? 'File deleted' : 'No content available'}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const MIN_WIDTH = 280;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 400;

export function ArtifactsPanel() {
  const { session } = useSessionStore();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('diff');
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchArtifacts = useCallback(async () => {
    if (!session.sessionId) return;

    setLoading(true);
    try {
      const response = await authFetch(`/api/sessions/${session.sessionId}/artifacts`);
      if (response.ok) {
        const data = await response.json();
        setArtifacts(data.artifacts || []);
      }
    } catch (e) {
      console.error('Failed to fetch artifacts:', e);
    } finally {
      setLoading(false);
    }
  }, [session.sessionId]);

  useEffect(() => {
    fetchArtifacts();
  }, [fetchArtifacts]);

  useEffect(() => {
    if (!session.sessionId) return;
    const interval = setInterval(fetchArtifacts, 5000);
    return () => clearInterval(interval);
  }, [session.sessionId, fetchArtifacts]);

  // Handle resize
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  // Group artifacts by file path and compute final state
  const fileStates = useMemo(() => {
    const fileMap = new Map<string, Artifact[]>();
    
    // Group by file path
    for (const artifact of artifacts) {
      const existing = fileMap.get(artifact.file_path) || [];
      existing.push(artifact);
      fileMap.set(artifact.file_path, existing);
    }

    // Convert to FileState objects
    const states: FileState[] = [];
    for (const [filePath, fileArtifacts] of fileMap) {
      // Sort by timestamp
      const sorted = [...fileArtifacts].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      
      const first = sorted[0];
      const latest = sorted[sorted.length - 1];
      
      // Determine content before (from first artifact) and after (from latest)
      let contentBefore = first.content_before || '';
      let contentAfter = latest.content_after || '';
      
      // For edits, if we don't have full content, try to use what we have
      if (!contentAfter && latest.diff) {
        // If we only have diff, we can't show preview mode properly
        // but the diff viewer can parse unified diffs
        contentAfter = latest.content_after || '';
      }

      states.push({
        filePath,
        artifacts: sorted,
        latestArtifact: latest,
        contentBefore,
        contentAfter,
        operation: latest.operation,
      });
    }

    // Sort by most recent activity
    return states.sort(
      (a, b) =>
        new Date(b.latestArtifact.timestamp).getTime() -
        new Date(a.latestArtifact.timestamp).getTime()
    );
  }, [artifacts]);

  const created = artifacts.filter((a) => a.operation === 'create').length;
  const edited = artifacts.filter((a) => a.operation === 'edit').length;
  const deleted = artifacts.filter((a) => a.operation === 'delete').length;

  // Collapsed state - just a toggle button
  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed right-0 top-1/2 -translate-y-1/2 bg-gray-800 border border-gray-700 border-r-0 rounded-l-lg p-2 text-gray-400 hover:text-white hover:bg-gray-700 transition-all z-10"
        title="Open Artifacts Panel"
      >
        <div className="flex flex-col items-center gap-1">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          {artifacts.length > 0 && (
            <span className="text-xs bg-blue-600 text-white rounded-full px-1.5 py-0.5">
              {fileStates.length}
            </span>
          )}
        </div>
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      className="flex flex-col h-full border-l border-gray-700 bg-gray-900 transition-all duration-200 relative"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500/50 transition-colors z-10"
        onMouseDown={() => setIsResizing(true)}
      />

      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b border-gray-700 bg-gray-800/50">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-200">Artifacts</span>
          {fileStates.length > 0 && (
            <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded">
              {fileStates.length} file{fileStates.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs">
            {created > 0 && <span className="text-green-400">+{created}</span>}
            {edited > 0 && <span className="text-yellow-400">~{edited}</span>}
            {deleted > 0 && <span className="text-red-400">-{deleted}</span>}
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            title="Close panel"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* View Mode Toggle */}
      {fileStates.length > 0 && (
        <div className="flex items-center gap-1 p-2 border-b border-gray-700/50 bg-gray-800/30">
          <button
            onClick={() => setViewMode('diff')}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              viewMode === 'diff'
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            <span className="flex items-center justify-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              Changes
            </span>
          </button>
          <button
            onClick={() => setViewMode('preview')}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              viewMode === 'preview'
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            <span className="flex items-center justify-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              Preview
            </span>
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading && artifacts.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-4">Loading...</div>
        ) : fileStates.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">
            <svg className="w-12 h-12 mx-auto mb-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            No file changes yet
          </div>
        ) : (
          <div>
            {fileStates.map((fileState) => (
              <FileCard key={fileState.filePath} fileState={fileState} viewMode={viewMode} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
