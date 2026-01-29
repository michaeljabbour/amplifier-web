/**
 * Session history sidebar - persistent left navigation for session management.
 * 
 * Shows all saved sessions with ability to resume, create new, search, rename, or delete.
 * Includes right-click context menu and auto-naming support.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  session: SavedSession | null;
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
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, session: null });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

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
    const interval = setInterval(loadSessions, 30000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  useEffect(() => {
    if (currentSessionId) {
      const timeout = setTimeout(loadSessions, 1000);
      return () => clearTimeout(timeout);
    }
  }, [currentSessionId, loadSessions]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(prev => ({ ...prev, visible: false }));
    if (contextMenu.visible) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu.visible]);

  // Focus rename input when editing
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const handleDelete = async (sessionId: string) => {
    if (!confirm('Delete this session? This cannot be undone.')) return;
    try {
      const response = await authFetch(`/api/sessions/history/${sessionId}`, { method: 'DELETE' });
      if (response.ok) {
        setSessions(prev => prev.filter(s => s.session_id !== sessionId));
      }
    } catch (e) {
      console.error('Failed to delete session:', e);
    }
  };

  const handleRename = async (sessionId: string, newName: string) => {
    try {
      const response = await authFetch(`/api/sessions/history/${sessionId}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (response.ok) {
        setSessions(prev => prev.map(s => 
          s.session_id === sessionId ? { ...s, name: newName } : s
        ));
      }
    } catch (e) {
      console.error('Failed to rename session:', e);
    }
    setRenamingId(null);
  };

  const handleContextMenu = (e: React.MouseEvent, session: SavedSession) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, session });
  };

  const handleSessionClick = (session: SavedSession) => {
    // Don't resume if already the current session
    if (session.session_id === currentSessionId) return;
    onResume(session);
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

  // Filter sessions by search query
  const filteredSessions = sessions.filter(session => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    const name = (session.name || `Session ${session.session_id.slice(0, 6)}`).toLowerCase();
    const bundle = session.bundle_name.toLowerCase();
    const cwd = (session.cwd || '').toLowerCase();
    return name.includes(query) || bundle.includes(query) || cwd.includes(query) || session.session_id.includes(query);
  });

  // Group sessions by date
  const groupedSessions = filteredSessions.reduce((groups, session) => {
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
    
    if (!groups[groupKey]) groups[groupKey] = [];
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
      {/* Header with New Session button */}
      <div className="p-2 border-b border-gray-700 flex items-center gap-1">
        <button
          onClick={onNewSession}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New
        </button>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            title="Collapse sidebar"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* Search */}
      <div className="p-2 border-b border-gray-800">
        <div className="relative">
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-gray-500 text-sm">Loading...</div>
        ) : filteredSessions.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            {searchQuery ? 'No matching sessions' : 'No sessions yet.\nStart chatting to create one.'}
          </div>
        ) : (
          <div className="py-1">
            {groupOrder.map(group => {
              const groupSessions = groupedSessions[group];
              if (!groupSessions || groupSessions.length === 0) return null;
              
              return (
                <div key={group} className="mb-1">
                  <div className="px-3 py-1 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {group}
                  </div>
                  {groupSessions.map(session => {
                    const isActive = session.session_id === currentSessionId;
                    const isCurrent = session.status === 'active';
                    const isRenaming = renamingId === session.session_id;
                    
                    return (
                      <div
                        key={session.session_id}
                        onClick={() => !isRenaming && handleSessionClick(session)}
                        onContextMenu={(e) => handleContextMenu(e, session)}
                        className={`group mx-1 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-gray-700 text-white'
                            : 'hover:bg-gray-800 text-gray-300'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1">
                              {isCurrent && (
                                <span className="w-1.5 h-1.5 bg-green-500 rounded-full flex-shrink-0" />
                              )}
                              {isRenaming ? (
                                <input
                                  ref={renameInputRef}
                                  type="text"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onBlur={() => handleRename(session.session_id, renameValue)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleRename(session.session_id, renameValue);
                                    if (e.key === 'Escape') setRenamingId(null);
                                  }}
                                  className="flex-1 bg-gray-600 border border-gray-500 rounded px-1 py-0.5 text-sm text-white focus:outline-none focus:border-blue-500"
                                  onClick={(e) => e.stopPropagation()}
                                />
                              ) : (
                                <span className="text-sm font-medium truncate">
                                  {session.name || `Session ${session.session_id.slice(0, 6)}`}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                              <span>{session.bundle_name}</span>
                              <span>·</span>
                              <span>{formatDate(session.updated_at)}</span>
                            </div>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(session.session_id); }}
                            className="p-0.5 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Delete session"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

      {/* Context Menu */}
      {contextMenu.visible && contextMenu.session && (
        <div
          className="fixed bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 z-50 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              setRenamingId(contextMenu.session!.session_id);
              setRenameValue(contextMenu.session!.name || `Session ${contextMenu.session!.session_id.slice(0, 6)}`);
              setContextMenu({ ...contextMenu, visible: false });
            }}
            className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Rename
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(contextMenu.session!.session_id);
              setContextMenu({ ...contextMenu, visible: false });
            }}
            className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
            </svg>
            Copy ID
          </button>
          <div className="border-t border-gray-700 my-1" />
          <button
            onClick={() => {
              handleDelete(contextMenu.session!.session_id);
              setContextMenu({ ...contextMenu, visible: false });
            }}
            className="w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-gray-700 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
