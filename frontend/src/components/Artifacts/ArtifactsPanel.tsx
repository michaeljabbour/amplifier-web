/**
 * Artifacts panel showing file changes made during the session.
 * Displays diffs with +/- indicators like an IDE.
 * Resizable, collapsible with smooth fly-in/out animation.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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

interface DiffLineProps {
  line: string;
  index: number;
}

function DiffLine({ line, index }: DiffLineProps) {
  let className = 'font-mono text-xs whitespace-pre-wrap ';
  let prefix = ' ';

  if (line.startsWith('+')) {
    className += 'bg-green-900/30 text-green-400';
    prefix = '+';
  } else if (line.startsWith('-')) {
    className += 'bg-red-900/30 text-red-400';
    prefix = '-';
  } else {
    className += 'text-gray-400';
  }

  return (
    <div className={className}>
      <span className="select-none text-gray-600 mr-2">{index + 1}</span>
      <span className="select-none text-gray-500 mr-2">{prefix}</span>
      {line.slice(1) || line}
    </div>
  );
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [expanded, setExpanded] = useState(false);

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

  const diffLines = artifact.diff?.split('\n') || [];
  const time = new Date(artifact.timestamp).toLocaleTimeString();
  const filename = artifact.file_path.split('/').pop() || artifact.file_path;

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 p-2 hover:bg-gray-800/50 transition-colors text-left"
      >
        <span
          className={`w-6 h-6 rounded flex items-center justify-center text-sm font-bold ${operationColors[artifact.operation]}`}
        >
          {operationIcons[artifact.operation]}
        </span>
        <span className="flex-1 font-mono text-sm text-gray-200 truncate" title={artifact.file_path}>
          {filename}
        </span>
        <span className="text-xs text-gray-500">{time}</span>
        <span className="text-gray-500">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-700 bg-gray-900/50 p-2">
          <div className="text-xs text-gray-500 mb-2 font-mono">{artifact.file_path}</div>
          {diffLines.length > 0 ? (
            <div className="max-h-64 overflow-y-auto">
              {diffLines.map((line, i) => (
                <DiffLine key={i} line={line} index={i} />
              ))}
            </div>
          ) : artifact.content_after ? (
            <div className="max-h-64 overflow-y-auto">
              <pre className="text-xs text-gray-300 whitespace-pre-wrap">{artifact.content_after}</pre>
            </div>
          ) : (
            <div className="text-xs text-gray-500 italic">No diff available</div>
          )}
        </div>
      )}
    </div>
  );
}

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;

export function ArtifactsPanel() {
  const { session } = useSessionStore();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
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
              {artifacts.length}
            </span>
          )}
        </div>
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      className="flex flex-col h-full border-l border-gray-700 bg-gray-900 transition-all duration-200"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500/50 transition-colors"
        onMouseDown={() => setIsResizing(true)}
      />

      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b border-gray-700 bg-gray-800/50">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-200">Artifacts</span>
          {artifacts.length > 0 && (
            <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded">
              {artifacts.length}
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading && artifacts.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-4">Loading...</div>
        ) : artifacts.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">
            <svg className="w-12 h-12 mx-auto mb-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            No file changes yet
          </div>
        ) : (
          <div>
            {artifacts.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
