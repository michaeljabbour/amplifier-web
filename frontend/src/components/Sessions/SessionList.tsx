/**
 * Session history list - shows saved sessions for resume.
 */

import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../../stores/authStore';

interface SavedSession {
  session_id: string;
  bundle_name: string;
  name: string | null;
  turn_count: number;
  created_at: string;
  updated_at: string;
  status: string;
  cwd: string | null;
}

interface SessionListProps {
  onResume: (session: SavedSession) => void;
  onNewSession: () => void;
  onClose: () => void;
}

export function SessionList({ onResume, onNewSession, onClose }: SessionListProps) {
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch('/api/sessions/history');
      if (response.ok) {
        setSessions(await response.json());
      } else {
        setError('Failed to load sessions');
      }
    } catch (e) {
      setError('Failed to connect to server');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleDelete = async (sessionId: string) => {
    if (!confirm('Delete this session? This cannot be undone.')) return;

    try {
      const response = await authFetch(`/api/sessions/history/${sessionId}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        setSessions(prev => prev.filter(s => s.session_id !== sessionId));
      }
    } catch (e) {
      console.error('Failed to delete session:', e);
    }
  };

  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">Sessions</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="text-center text-gray-400 py-8">Loading...</div>
          ) : error ? (
            <div className="text-center text-red-400 py-8">{error}</div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-gray-400 py-8">
              No saved sessions yet.
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map(session => (
                <div
                  key={session.session_id}
                  className="bg-gray-700/50 rounded-lg p-3 hover:bg-gray-700 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white truncate">
                          {session.name || session.session_id.slice(0, 8)}
                        </span>
                        <span className="text-xs px-1.5 py-0.5 bg-gray-600 rounded text-gray-300">
                          {session.bundle_name}
                        </span>
                        {session.status === 'active' && (
                          <span className="text-xs px-1.5 py-0.5 bg-green-600 rounded text-white font-medium animate-pulse">
                            Active
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-gray-400 mt-1">
                        {session.turn_count} turn{session.turn_count !== 1 ? 's' : ''} · {formatDate(session.updated_at)}
                      </div>
                      {session.cwd && (
                        <div className="text-xs text-gray-500 font-mono mt-1 truncate">
                          {session.cwd}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onResume(session)}
                        className={`px-3 py-1.5 text-white rounded text-sm transition-colors ${
                          session.status === 'active'
                            ? 'bg-green-600 hover:bg-green-700'
                            : 'bg-amplifier-600 hover:bg-amplifier-700'
                        }`}
                      >
                        {session.status === 'active' ? 'Reconnect' : 'Resume'}
                      </button>
                      <button
                        onClick={() => handleDelete(session.session_id)}
                        className="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
                        title="Delete session"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-700">
          <button
            onClick={onNewSession}
            className="w-full py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            Start New Session
          </button>
        </div>
      </div>
    </div>
  );
}
