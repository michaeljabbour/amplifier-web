/**
 * Main application component for Amplifier Web.
 */

import { useEffect, useState, useCallback } from 'react';
import { useSessionStore } from './stores/sessionStore';
import { useAuthStore, authFetch } from './stores/authStore';
import { usePrefsStore } from './stores/prefsStore';
import { useWebSocket } from './hooks/useWebSocket';
import { ChatContainer } from './components/Chat/ChatContainer';
import { ConfigPanel } from './components/Config/ConfigPanel';
import { ApprovalModal } from './components/Tools/ApprovalModal';
import { LoginModal } from './components/Auth/LoginModal';
import { SessionList } from './components/Sessions/SessionList';

/**
 * Generate a UUID, with fallback for non-secure contexts (HTTP).
 * crypto.randomUUID() requires a secure context (HTTPS), so we provide
 * a fallback for development/LAN access over HTTP.
 */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface SavedSession {
  session_id: string;
  bundle_name: string;
  name: string | null;
  turn_count: number;
  cwd: string | null;
}

/**
 * Format a path for display:
 * - Replace home directory with ~
 * - Truncate from middle to preserve final directory
 */
function formatPath(path: string, maxLen = 30): string {
  // Try to detect home directory prefix (common patterns)
  const homePatterns = ['/Users/', '/home/'];
  let displayPath = path;

  for (const pattern of homePatterns) {
    const idx = path.indexOf(pattern);
    if (idx === 0) {
      const afterHome = path.slice(pattern.length);
      const slashIdx = afterHome.indexOf('/');
      if (slashIdx >= 0) {
        displayPath = '~' + afterHome.slice(slashIdx);
      } else {
        displayPath = '~';
      }
      break;
    }
  }

  // If still too long, truncate from middle preserving end
  if (displayPath.length > maxLen) {
    const lastSlash = displayPath.lastIndexOf('/');
    if (lastSlash > 0) {
      const end = displayPath.slice(lastSlash); // Keep final /dirname
      const availableForStart = maxLen - end.length - 3; // -3 for "..."
      if (availableForStart > 3) {
        const start = displayPath.slice(0, availableForStart);
        displayPath = start + '...' + end;
      }
    }
  }

  return displayPath;
}

function App() {
  const { isConnected, createSession, sendPrompt, sendApproval, cancel } = useWebSocket();
  const { session, pendingApproval, clearMessages, clearSubSessions, addMessage } = useSessionStore();
  const { token, isAuthenticated, isVerifying, verifyToken } = useAuthStore();
  const { defaultBundle, defaultBehaviors, showThinking, defaultCwd, loadFromServer } = usePrefsStore();
  const [showConfig, setShowConfig] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);

  // Verify token on mount
  useEffect(() => {
    const checkAuth = async () => {
      if (token) {
        await verifyToken();
      }
      setAuthChecked(true);
    };
    checkAuth();
  }, [token, verifyToken]);

  // Load preferences when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      loadFromServer();
    }
  }, [isAuthenticated, loadFromServer]);

  // Show session list on first load when connected but no session started
  useEffect(() => {
    if (isAuthenticated && isConnected && !session.sessionId && !sessionStarted) {
      setShowSessionList(true);
    }
  }, [isAuthenticated, isConnected, session.sessionId, sessionStarted]);

  // Handle starting a new session
  const handleNewSession = useCallback(() => {
    setShowSessionList(false);
    setSessionStarted(true);
    createSession({
      bundle: defaultBundle,
      behaviors: defaultBehaviors.length > 0 ? defaultBehaviors : undefined,
      showThinking,
      cwd: defaultCwd || undefined,
    });
  }, [createSession, defaultBundle, defaultBehaviors, showThinking, defaultCwd]);

  // Handle resuming a saved session
  const handleResumeSession = useCallback(async (saved: SavedSession) => {
    setShowSessionList(false);
    setSessionStarted(true);
    // Clear any existing messages
    clearMessages();
    clearSubSessions();

    // Fetch the stored transcript to display in the UI
    try {
      const response = await authFetch(`/api/sessions/history/${saved.session_id}/transcript`);
      if (response.ok) {
        const data = await response.json();
        const transcript = data.transcript || [];

        // Add each message to the UI
        for (const msg of transcript) {
          if (msg.role === 'user' || msg.role === 'assistant') {
            // Convert transcript format to frontend Message format
            let content: Array<{ type: 'text' | 'thinking'; content: string }>;
            if (typeof msg.content === 'string') {
              content = [{ type: 'text' as const, content: msg.content }];
            } else {
              // Filter and map content blocks - handle both text and thinking
              content = (msg.content || [])
                .filter((block: { type?: string }) => block.type === 'text' || block.type === 'thinking')
                .map((block: { type?: string; text?: string; thinking?: string }) => ({
                  type: (block.type === 'thinking' ? 'thinking' : 'text') as 'text' | 'thinking',
                  content: block.text || block.thinking || '',
                }))
                .filter((block: { content: string }) => block.content); // Remove empty blocks
            }

            addMessage({
              id: generateUUID(),
              role: msg.role,
              content,
              timestamp: new Date(msg.timestamp || Date.now()),
            });
          }
        }
      }
    } catch (e) {
      console.error('Failed to load transcript:', e);
    }

    // Add system message indicating session resume
    addMessage({
      id: generateUUID(),
      role: 'system',
      content: [{ type: 'text', content: `**Session Resumed**\n\nRestoring conversation from \`${saved.session_id.slice(0, 8)}...\` (${saved.turn_count} turn${saved.turn_count !== 1 ? 's' : ''})` }],
      timestamp: new Date(),
    });

    // Resume session - backend loads transcript for context
    createSession({
      bundle: saved.bundle_name,
      showThinking,
      cwd: saved.cwd || undefined,
      resumeSessionId: saved.session_id,  // Backend loads transcript for context
    });
  }, [createSession, showThinking, clearMessages, clearSubSessions, addMessage]);

  // Show loading while checking auth
  if (!authChecked || isVerifying) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-4 border-amplifier-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  // Show login if not authenticated
  if (!isAuthenticated) {
    return (
      <div className="h-screen bg-gray-900">
        <LoginModal
          onSuccess={() => {
            // Token verification already updates isAuthenticated
          }}
        />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-gray-700 bg-gray-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-white">Amplifier Web</h1>
            <span className="text-sm text-gray-400">
              {session.bundle && `Bundle: ${session.bundle}`}
            </span>
            {session.cwd && (
              <span className="text-xs text-gray-500 font-mono" title={session.cwd}>
                {formatPath(session.cwd)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {/* Connection status */}
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  isConnected ? 'bg-green-500' : 'bg-red-500'
                }`}
              />
              <span className="text-sm text-gray-400">
                {session.status === 'executing'
                  ? 'Running...'
                  : isConnected
                  ? 'Connected'
                  : 'Disconnected'}
              </span>
            </div>

            {/* Sessions button */}
            <button
              onClick={() => setShowSessionList(true)}
              className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded-md transition-colors"
            >
              Sessions
            </button>

            {/* Config button */}
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded-md transition-colors"
            >
              Configure
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat area */}
        <div className="flex-1 flex flex-col">
          <ChatContainer
            onSendMessage={sendPrompt}
            onCancel={cancel}
            isExecuting={session.status === 'executing'}
          />
        </div>

        {/* Config panel (slide-out) */}
        {showConfig && (
          <div className="w-80 border-l border-gray-700 bg-gray-800 overflow-y-auto">
            <ConfigPanel
              onClose={() => setShowConfig(false)}
              onCreateSession={(config) => {
                setSessionStarted(true);
                createSession(config);
                setShowConfig(false);
              }}
            />
          </div>
        )}
      </div>

      {/* Approval modal */}
      {pendingApproval && (
        <ApprovalModal
          approval={pendingApproval}
          onResponse={(choice) => sendApproval(pendingApproval.id, choice)}
        />
      )}

      {/* Session list modal */}
      {showSessionList && (
        <SessionList
          onResume={handleResumeSession}
          onNewSession={handleNewSession}
          onClose={() => setShowSessionList(false)}
        />
      )}
    </div>
  );
}

export default App;
