/**
 * Artifacts panel showing file changes made during the session.
 * Displays diffs with +/- indicators like an IDE.
 */

import { useState, useEffect, useCallback } from 'react';
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

  // Parse diff into lines
  const diffLines = artifact.diff?.split('\n') || [];

  // Format timestamp
  const time = new Date(artifact.timestamp).toLocaleTimeString();

  // Get filename from path
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
            <div className="max-h-48 overflow-y-auto">
              {diffLines.map((line, i) => (
                <DiffLine key={i} line={line} index={i} />
              ))}
            </div>
          ) : artifact.content_after ? (
            <div className="max-h-48 overflow-y-auto">
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

export function ArtifactsPanel() {
  const { session } = useSessionStore();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

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

  // Fetch artifacts when session changes
  useEffect(() => {
    fetchArtifacts();
  }, [fetchArtifacts]);

  // Poll for new artifacts every 5 seconds during active session
  useEffect(() => {
    if (!session.sessionId) return;

    const interval = setInterval(fetchArtifacts, 5000);
    return () => clearInterval(interval);
  }, [session.sessionId, fetchArtifacts]);

  // Summary stats
  const created = artifacts.filter((a) => a.operation === 'create').length;
  const edited = artifacts.filter((a) => a.operation === 'edit').length;
  const deleted = artifacts.filter((a) => a.operation === 'delete').length;

  if (!session.sessionId && artifacts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col h-full border-l border-gray-700 bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 text-gray-300 hover:text-white"
        >
          <span className="text-sm font-medium">Artifacts</span>
          {artifacts.length > 0 && (
            <span className="text-xs text-gray-500">({artifacts.length})</span>
          )}
        </button>
        <div className="flex items-center gap-2 text-xs">
          {created > 0 && <span className="text-green-400">+{created}</span>}
          {edited > 0 && <span className="text-yellow-400">~{edited}</span>}
          {deleted > 0 && <span className="text-red-400">-{deleted}</span>}
        </div>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto p-2">
          {loading && artifacts.length === 0 ? (
            <div className="text-center text-gray-500 text-sm py-4">Loading...</div>
          ) : artifacts.length === 0 ? (
            <div className="text-center text-gray-500 text-sm py-4">
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
      )}
    </div>
  );
}
