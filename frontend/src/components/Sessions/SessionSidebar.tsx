/**
 * Session history sidebar - persistent left navigation for session management.
 * 
 * Shows all saved sessions with ability to resume, create new, or delete.
 * Designed to match modern AI chat interfaces (ChatGPT, Claude, etc.)
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

interface SessionSidebarProps {
  currentSessionId: string | null;
  onResume: (session: SavedSession) => void;
  onNewSession: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function SessionSidebar({
  currentSessionId,
  onResume,
  onNewSession,
  isCollapsed = false,
  onToggleCollapse,
}: SessionSidebarProps) {
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch('/api/sessions/history');
      if (response.ok) {
        setSessions(await response.json());
      }
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSessions();
    // Refresh session list periodically
    const interval = setInterval(loadSessions, 30000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  // Refresh when current session changes
  useEffect(() => {
    if (currentSessionId) {
      // Small delay to let backend save session info
      const timeout = setTimeout(loadSessions, 1000);
      return () => clearTimeout(timeout);
    }
  }, [currentSessionId, loadSessions]);

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
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

  // Group sessions by date
  const groupedSessions = sessions.reduce((groups, session) => {
    const date = new Date(session.updated_at);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    let groupKey: string;
    if (date.toDateString() === today.toDateString()) {
      groupKey = 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      groupKey = 'Yesterday';
    } else if (date > new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)) {
      groupKey = 'This Week';
    } else {
      groupKey = 'Older';
    }
    
    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    groups[groupKey].push(session);
    return groups;
  }, {} as Record<string, SavedSession[]>);

  const groupOrder = ['Today', 'Yesterday', 'This Week', 'Older'];

  if (isCollapsed) {
    return (
      <div className="w-12 bg-gray-900 border-r border-gray-700 flex flex-col items-center py-3 gap-2">
        <button
          onClick={onToggleCollapse}
          className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
          title="Expand sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button
          onClick={onNewSession}
          className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
          title="New session"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="w-64 bg-gray-900 border-r border-gray-700 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-gray-700 flex items-center justify-between">
        <button
          onClick={onNewSession}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Session
        </button>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="ml-2 p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
            title="Collapse sidebar"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-gray-500 text-sm">Loading...</div>
        ) : sessions.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            No sessions yet.<br />
            Start chatting to create one.
          </div>
        ) : (
          <div className="py-2">
            {groupOrder.map(group => {
              const groupSessions = groupedSessions[group];
              if (!groupSessions || groupSessions.length === 0) return null;
              
              return (
                <div key={group} className="mb-2">
                  <div className="px-3 py-1 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {group}
                  </div>
                  {groupSessions.map(session => {
                    const isActive = session.session_id === currentSessionId;
                    const isCurrent = session.status === 'active';
                    
                    return (
                      <div
                        key={session.session_id}
                        onClick={() => onResume(session)}
                        className={`group mx-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-gray-700 text-white'
                            : 'hover:bg-gray-800 text-gray-300'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              {isCurrent && (
                                <span className="w-1.5 h-1.5 bg-green-500 rounded-full flex-shrink-0" />
                              )}
                              <span className="text-sm font-medium truncate">
                                {session.name || `Session ${session.session_id.slice(0, 6)}`}
                              </span>
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                              <span>{session.bundle_name}</span>
                              <span>·</span>
                              <span>{formatDate(session.updated_at)}</span>
                            </div>
                          </div>
                          <button
                            onClick={(e) => handleDelete(e, session.session_id)}
                            className="p-1 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Delete session"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
