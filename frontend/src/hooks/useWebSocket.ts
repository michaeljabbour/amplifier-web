/**
 * WebSocket hook for Amplifier session communication.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useAuthStore } from '../stores/authStore';
import type {
  ServerMessage,
  ClientMessage,
  Message,
} from '../types/amplifier';

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

// Build WebSocket URL (no auth in URL - auth is sent as first message)
const getWsUrl = () => {
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/session`;
};

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<number>();
  const pingIntervalRef = useRef<number>();

  // Track mapping from server block indices to local array indices
  // This resets on each model response (after tool_result) to accumulate blocks
  const blockIndexMapRef = useRef<Map<number, number>>(new Map());
  const nextLocalIndexRef = useRef<number>(0);

  // Track insertion order for chronological rendering of content and tool calls
  const orderCounterRef = useRef<number>(0);

  const {
    setSession,
    addMessage,
    updateLastAssistantMessage,
    addToolCallToLastMessage,
    updateToolCallInLastMessage,
    clearMessages,
    setStreaming,
    setCurrentBlockIndex,
    setPendingApproval,
    addDisplayMessage,
    clearSubSessions,
    // Sub-session actions
    startSubSession,
    updateSubSessionContent,
    addSubSessionToolCall,
    updateSubSessionToolCall,
    endSubSession,
  } = useSessionStore();

  // Track block index mappings per sub-session (keyed by parent_tool_call_id)
  const subSessionBlockMapRef = useRef<Map<string, Map<number, number>>>(new Map());
  const subSessionNextIndexRef = useRef<Map<string, number>>(new Map());
  const subSessionOrderRef = useRef<Map<string, number>>(new Map());
  // Map from child_session_id to parent tool_call_id (for routing when parent_tool_call_id not in event)
  const childSessionToToolCallRef = useRef<Map<string, string>>(new Map());

  // Handle incoming messages
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      const eventType = data.type || 'unknown';

      // Log ALL events with raw data - categorize by pattern for visual filtering
      // Always pass raw `data` object so it can be fully inspected in DevTools
      if (eventType !== 'pong') {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);

        // Determine icon and color based on event type pattern
        let icon = '📨';
        let color = '#6b7280'; // gray

        if (eventType.includes('bundle') || eventType.includes('config')) {
          icon = '📦'; color = '#9333ea'; // purple
        } else if (eventType.includes('provider_request') || eventType.includes('llm_request')) {
          icon = '🔼'; color = '#f59e0b'; // amber
        } else if (eventType.includes('provider_response') || eventType.includes('llm_response')) {
          icon = '🔽'; color = '#10b981'; // green
        } else if (eventType.includes('fork') || eventType.includes('spawn')) {
          icon = '🍴'; color = '#8b5cf6'; // violet
        } else if (eventType.includes('session')) {
          icon = '🎬'; color = '#6366f1'; // indigo
        } else if (eventType.includes('compact') || eventType.includes('context')) {
          icon = '📉'; color = '#ef4444'; // red
        } else if (eventType.includes('tool')) {
          icon = '🔧'; color = '#3b82f6'; // blue
        } else if (eventType.includes('content') || eventType.includes('thinking')) {
          icon = '📝'; color = '#6b7280'; // gray
        } else if (eventType.includes('approval')) {
          icon = '✋'; color = '#eab308'; // yellow
        } else if (eventType.includes('error')) {
          icon = '❌'; color = '#dc2626'; // red
        } else if (eventType.includes('cancel')) {
          icon = '🛑'; color = '#f97316'; // orange
        }

        // Log with icon, color, and FULL raw data object
        console.log(
          `%c[${timestamp}] ${icon} ${eventType}`,
          `color: ${color}; font-weight: bold`,
          data
        );
      }

      // Cast for type-safe handling below (but logging above captures everything)
      const typedData = data as ServerMessage;

      switch (typedData.type) {
        case 'session_created':
          setSession({
            sessionId: typedData.session_id,
            bundle: typedData.bundle,
            behaviors: typedData.behaviors,
            status: 'connected',
            cwd: typedData.cwd,
          });
          break;

        case 'session_fork': {
          // A sub-session has been spawned
          // If parent_tool_call_id is provided, use it; otherwise find the OLDEST pending task tool (FIFO)
          let toolCallId = typedData.parent_tool_call_id;

          if (!toolCallId) {
            // Find the OLDEST pending "task" tool call (FIFO order for parallel tasks)
            const store = useSessionStore.getState();
            const lastMsg = store.messages[store.messages.length - 1];
            if (lastMsg?.role === 'assistant' && lastMsg.toolCalls) {
              // Get pending task tools that don't already have a sub-session
              const pendingTaskTools = lastMsg.toolCalls.filter(
                tc => tc.name === 'task' &&
                      (tc.status === 'pending' || tc.status === 'running') &&
                      !store.subSessions.has(tc.id)
              );

              // Take the FIRST (oldest) pending task - FIFO order
              if (pendingTaskTools.length > 0) {
                toolCallId = pendingTaskTools[0].id;
              }
            }
          }

          if (toolCallId) {
            startSubSession(toolCallId, typedData.child_id, typedData.agent);
            // Initialize tracking refs for this sub-session
            subSessionBlockMapRef.current.set(toolCallId, new Map());
            subSessionNextIndexRef.current.set(toolCallId, 0);
            subSessionOrderRef.current.set(toolCallId, 0);
            // Store mapping from child_session_id to toolCallId for event routing
            childSessionToToolCallRef.current.set(typedData.child_id, toolCallId);
          }
          break;
        }

        case 'content_start': {
          // Check if this is a sub-session event
          // Try to get parent_tool_call_id directly, or look it up via child_session_id
          let parentToolCallId = typedData.parent_tool_call_id;
          if (!parentToolCallId && typedData.child_session_id) {
            parentToolCallId = childSessionToToolCallRef.current.get(typedData.child_session_id);
          }
          const nestingDepth = typedData.nesting_depth || 0;

          // Map block_type to valid ContentBlock type
          const blockType = typedData.block_type === 'tool_use' ? 'tool_use'
            : typedData.block_type === 'thinking' ? 'thinking'
            : 'text' as const;

          if (parentToolCallId && nestingDepth > 0) {
            // Route to sub-session
            const blockMap = subSessionBlockMapRef.current.get(parentToolCallId) || new Map();
            const nextIndex = subSessionNextIndexRef.current.get(parentToolCallId) || 0;
            const orderCounter = subSessionOrderRef.current.get(parentToolCallId) || 0;

            const localIndex = nextIndex;
            blockMap.set(typedData.index, localIndex);
            subSessionBlockMapRef.current.set(parentToolCallId, blockMap);
            subSessionNextIndexRef.current.set(parentToolCallId, nextIndex + 1);
            subSessionOrderRef.current.set(parentToolCallId, orderCounter + 1);

            updateSubSessionContent(parentToolCallId, (blocks) => [
              ...blocks,
              { type: blockType, content: '', isStreaming: true, order: orderCounter },
            ]);
          } else {
            // Main session content
            setStreaming(true);
            setCurrentBlockIndex(typedData.index);

            // Create new assistant message if needed
            const store = useSessionStore.getState();
            const lastMsg = store.messages[store.messages.length - 1];
            if (!lastMsg || lastMsg.role !== 'assistant' || !store.isStreaming) {
              // Reset index mapping and order counter for new message
              blockIndexMapRef.current.clear();
              nextLocalIndexRef.current = 0;
              orderCounterRef.current = 0;

              // Assign local index for this server index
              const localIndex = nextLocalIndexRef.current++;
              blockIndexMapRef.current.set(typedData.index, localIndex);

              // Create new message with single block (with order)
              const newMessage: Message = {
                id: generateUUID(),
                role: 'assistant',
                content: [{
                  type: blockType,
                  content: '',
                  isStreaming: true,
                  order: orderCounterRef.current++,
                }],
                timestamp: new Date(),
              };
              addMessage(newMessage);
            } else {
              // Assign local index for this server index (always append)
              const localIndex = nextLocalIndexRef.current++;
              blockIndexMapRef.current.set(typedData.index, localIndex);

              // Append new block with order
              const order = orderCounterRef.current++;
              updateLastAssistantMessage((blocks) => [
                ...blocks,
                { type: blockType, content: '', isStreaming: true, order },
              ]);
            }
          }
          break;
        }

        case 'content_delta': {
          let parentToolCallId = typedData.parent_tool_call_id;
          if (!parentToolCallId && typedData.child_session_id) {
            parentToolCallId = childSessionToToolCallRef.current.get(typedData.child_session_id);
          }
          const nestingDepth = typedData.nesting_depth || 0;

          if (parentToolCallId && nestingDepth > 0) {
            // Route to sub-session
            const blockMap = subSessionBlockMapRef.current.get(parentToolCallId);
            const localIndex = blockMap?.get(typedData.index);
            if (localIndex === undefined) {
              break;
            }
            updateSubSessionContent(parentToolCallId, (blocks) => {
              const updated = [...blocks];
              if (updated[localIndex]) {
                updated[localIndex] = {
                  ...updated[localIndex],
                  content: updated[localIndex].content + typedData.delta,
                };
              }
              return updated;
            });
          } else {
            // Main session
            const localIndex = blockIndexMapRef.current.get(typedData.index);
            if (localIndex === undefined) {
              break;
            }
            updateLastAssistantMessage((blocks) => {
              const updated = [...blocks];
              if (updated[localIndex]) {
                updated[localIndex] = {
                  ...updated[localIndex],
                  content: updated[localIndex].content + typedData.delta,
                };
              }
              return updated;
            });
          }
          break;
        }

        case 'content_end': {
          let parentToolCallId = typedData.parent_tool_call_id;
          if (!parentToolCallId && typedData.child_session_id) {
            parentToolCallId = childSessionToToolCallRef.current.get(typedData.child_session_id);
          }
          const nestingDepth = typedData.nesting_depth || 0;

          if (parentToolCallId && nestingDepth > 0) {
            // Route to sub-session
            const blockMap = subSessionBlockMapRef.current.get(parentToolCallId);
            const localIndex = blockMap?.get(typedData.index);
            if (localIndex === undefined) {
              break;
            }
            updateSubSessionContent(parentToolCallId, (blocks) => {
              const updated = [...blocks];
              if (updated[localIndex]) {
                updated[localIndex] = {
                  ...updated[localIndex],
                  content: typedData.content || updated[localIndex].content,
                  isStreaming: false,
                };
              }
              return updated;
            });
          } else {
            // Main session
            const localIndex = blockIndexMapRef.current.get(typedData.index);
            if (localIndex === undefined) {
              break;
            }
            updateLastAssistantMessage((blocks) => {
              const updated = [...blocks];
              if (updated[localIndex]) {
                updated[localIndex] = {
                  ...updated[localIndex],
                  content: typedData.content || updated[localIndex].content,
                  isStreaming: false,
                };
              }
              return updated;
            });
          }
          break;
        }

        // Dedicated thinking events (extended thinking models)
        case 'thinking_delta': {
          // Find or create thinking block in current message
          updateLastAssistantMessage((blocks) => {
            const thinkingIdx = blocks.findIndex((b) => b.type === 'thinking' && b.isStreaming);
            if (thinkingIdx >= 0) {
              const updated = [...blocks];
              updated[thinkingIdx] = {
                ...updated[thinkingIdx],
                content: updated[thinkingIdx].content + typedData.delta,
              };
              return updated;
            }
            // No streaming thinking block found, create one
            return [...blocks, { type: 'thinking', content: typedData.delta, isStreaming: true }];
          });
          break;
        }

        case 'thinking_final':
          updateLastAssistantMessage((blocks) => {
            const thinkingIdx = blocks.findIndex((b) => b.type === 'thinking' && b.isStreaming);
            if (thinkingIdx >= 0) {
              const updated = [...blocks];
              updated[thinkingIdx] = {
                ...updated[thinkingIdx],
                content: typedData.content,
                isStreaming: false,
              };
              return updated;
            }
            return blocks;
          });
          break;

        case 'tool_call': {
          let parentToolCallId = typedData.parent_tool_call_id;
          if (!parentToolCallId && typedData.child_session_id) {
            parentToolCallId = childSessionToToolCallRef.current.get(typedData.child_session_id);
          }
          const nestingDepth = typedData.nesting_depth || 0;

          if (parentToolCallId && nestingDepth > 0) {
            // Route to sub-session
            const orderCounter = subSessionOrderRef.current.get(parentToolCallId) || 0;
            subSessionOrderRef.current.set(parentToolCallId, orderCounter + 1);
            addSubSessionToolCall(parentToolCallId, {
              id: typedData.tool_call_id,
              name: typedData.tool_name,
              arguments: typedData.arguments,
              status: typedData.status,
              order: orderCounter,
            });
          } else {
            // Main session
            addToolCallToLastMessage({
              id: typedData.tool_call_id,
              name: typedData.tool_name,
              arguments: typedData.arguments,
              status: typedData.status,
              order: orderCounterRef.current++,
            });
          }
          break;
        }

        case 'tool_result': {
          let parentToolCallId = typedData.parent_tool_call_id;
          if (!parentToolCallId && typedData.child_session_id) {
            parentToolCallId = childSessionToToolCallRef.current.get(typedData.child_session_id);
          }
          const nestingDepth = typedData.nesting_depth || 0;

          if (parentToolCallId && nestingDepth > 0) {
            // Route to sub-session
            updateSubSessionToolCall(parentToolCallId, typedData.tool_call_id, {
              status: typedData.success ? 'complete' : 'error',
              result: typedData.output,
              error: typedData.error,
            });
            // Reset sub-session block mapping for next iteration
            const blockMap = subSessionBlockMapRef.current.get(parentToolCallId);
            blockMap?.clear();
          } else {
            // Main session
            updateToolCallInLastMessage(typedData.tool_call_id, {
              status: typedData.success ? 'complete' : 'error',
              result: typedData.output,
              error: typedData.error,
            });
            // Reset index mapping - next model response will have indices starting at 0
            // but we want to append to our accumulated blocks
            blockIndexMapRef.current.clear();

            // If this is a task tool result, mark the associated sub-session as complete
            // (the tool_call_id is the parent_tool_call_id for the sub-session)
            const store = useSessionStore.getState();
            if (store.subSessions.has(typedData.tool_call_id)) {
              endSubSession(typedData.tool_call_id, typedData.success ? 'complete' : 'error');
              // Clean up tracking refs for this sub-session
              subSessionBlockMapRef.current.delete(typedData.tool_call_id);
              subSessionNextIndexRef.current.delete(typedData.tool_call_id);
              subSessionOrderRef.current.delete(typedData.tool_call_id);
              // Clean up childSessionToToolCall mapping
              for (const [childId, toolId] of childSessionToToolCallRef.current) {
                if (toolId === typedData.tool_call_id) {
                  childSessionToToolCallRef.current.delete(childId);
                  break;
                }
              }
            }
          }
          break;
        }

        case 'approval_request':
          setPendingApproval({
            id: typedData.id,
            prompt: typedData.prompt,
            options: typedData.options,
            timeout: typedData.timeout,
            default: typedData.default,
            remainingTime: typedData.timeout,
          });
          break;

        case 'display_message':
          addDisplayMessage({
            level: typedData.level,
            message: typedData.message,
            source: typedData.source,
          });
          break;

        case 'prompt_complete':
          // Filter out empty and undefined content blocks from the last message
          // (handles sparse arrays from index-based insertion and empty streaming blocks)
          updateLastAssistantMessage((blocks) =>
            blocks.filter((block) => block && block.content && block.content.trim() !== '')
          );
          setStreaming(false);
          setSession({
            status: 'connected',
            turnCount: typedData.turn,
          });
          // Reset index tracking for next turn
          blockIndexMapRef.current.clear();
          nextLocalIndexRef.current = 0;
          break;

        case 'error':
          addDisplayMessage({
            level: 'error',
            message: typedData.error,
          });
          setStreaming(false);
          break;

        case 'command_result':
          // Handle command results (e.g., /status, /tools)
          // Already logged with raw data above
          break;

        case 'pong':
          // Keep-alive acknowledged
          break;

        // All other events - logged above with raw data, no UI state changes needed
        // This catches any new events without requiring code changes
        default:
          break;
      }
    },
    [
      setSession,
      addMessage,
      updateLastAssistantMessage,
      addToolCallToLastMessage,
      updateToolCallInLastMessage,
      setStreaming,
      setCurrentBlockIndex,
      setPendingApproval,
      addDisplayMessage,
      startSubSession,
      updateSubSessionContent,
      addSubSessionToolCall,
      updateSubSessionToolCall,
      endSubSession,
    ]
  );

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Don't connect if not authenticated
    const { isAuthenticated, token } = useAuthStore.getState();
    if (!isAuthenticated || !token) {
      return;
    }

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }

    setSession({ status: 'connecting' });

    const ws = new WebSocket(getWsUrl());
    let intentionalClose = false;
    let wsAuthenticated = false;

    ws.onopen = () => {
      // Send auth message immediately after connection
      const { token } = useAuthStore.getState();
      if (token) {
        ws.send(JSON.stringify({ type: 'auth', token }));
      } else {
        // No token available, close connection
        ws.close(4001, 'No auth token');
      }
    };

    // Helper to complete connection setup after auth success
    const completeConnection = () => {
      wsAuthenticated = true;
      setIsConnected(true);
      setSession({ status: 'connected' });

      // Start ping interval
      pingIntervalRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };

    ws.onmessage = (event: MessageEvent) => {
      // Handle auth_success before delegating to main handler
      const data = JSON.parse(event.data);
      if (data.type === 'auth_success') {
        completeConnection();
        return;
      }
      // Only process other messages after authenticated
      if (wsAuthenticated) {
        handleMessage(event);
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      setSession({ status: 'disconnected', sessionId: null });

      // Clear ping interval
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }

      // Handle auth failure (code 4001)
      if (event.code === 4001) {
        // Auth token is invalid, clear it
        useAuthStore.getState().clearToken();
        return;
      }

      // Only reconnect if this wasn't an intentional close and we're still authenticated
      if (!intentionalClose && useAuthStore.getState().isAuthenticated) {
        reconnectTimeoutRef.current = window.setTimeout(() => {
          connect();
        }, 3000);
      }
    };

    ws.onerror = () => {
      // Suppress error logging - connection failures are handled by onclose
    };

    // Mark close as intentional when component unmounts
    wsRef.current = ws;
    (ws as WebSocket & { markIntentionalClose: () => void }).markIntentionalClose = () => {
      intentionalClose = true;
    };
  }, [handleMessage, setSession]);

  // Disconnect
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = undefined;
    }
    if (wsRef.current) {
      // Mark as intentional close to prevent reconnect attempts
      const ws = wsRef.current as WebSocket & { markIntentionalClose?: () => void };
      ws.markIntentionalClose?.();
      ws.close();
      wsRef.current = null;
    }
  }, []);

  // Send message
  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.error('WebSocket not connected');
    }
  }, []);

  // Create session
  const createSession = useCallback(
    (config: {
      bundle?: string;
      behaviors?: string[];
      provider?: Record<string, unknown>;
      showThinking?: boolean;
      keepHistory?: boolean;  // If true, reconfigure with existing history
      previousBundle?: string;  // For reconfigure: what bundle we're changing from
      previousBehaviors?: string[];  // For reconfigure: what behaviors we're changing from
      cwd?: string;  // Working directory for file operations
      resumeSessionId?: string;  // Session ID to resume (backend loads transcript)
    } = {}) => {
      // Get current messages if we're keeping history
      let initialTranscript: Array<{ role: string; content: unknown }> | undefined;

      if (config.keepHistory) {
        // Convert frontend messages to transcript format
        // Only include text blocks - thinking and tool blocks are ephemeral
        const { messages } = useSessionStore.getState();
        const converted: Array<{ role: string; content: unknown }> = [];

        for (const msg of messages) {
          // Skip system messages (like reconfigure notices) from transcript
          if (msg.role === 'system') continue;

          // Extract only text content from blocks
          const textBlocks = msg.content
            .filter(block => block.type === 'text' && block.content.trim())
            .map(block => ({ type: 'text' as const, text: block.content }));

          // Skip messages with no text content
          if (textBlocks.length === 0) continue;

          // For single text block, use string content (simpler format)
          // For multiple blocks, use array format
          converted.push({
            role: msg.role,
            content: textBlocks.length === 1 ? textBlocks[0].text : textBlocks,
          });
        }

        initialTranscript = converted;

        // Inject a system message indicating the reconfigure
        const prevBundle = config.previousBundle || 'unknown';
        const newBundle = config.bundle || 'foundation';
        const prevBehaviors = config.previousBehaviors?.join(', ') || 'none';
        const newBehaviors = config.behaviors?.join(', ') || 'none';

        const reconfigureMessage = `**Session Reconfigured** (experimental)

Configuration changed from \`${prevBundle}\` to \`${newBundle}\`
Behaviors: ${prevBehaviors} → ${newBehaviors}

*Note: This is an experimental feature. Some context may be lost and the model may not fully recall previous tool outputs, thinking, or detailed conversation nuances.*`;

        addMessage({
          id: generateUUID(),
          role: 'system',
          content: [{ type: 'text', content: reconfigureMessage }],
          timestamp: new Date(),
        });
      } else {
        // Clear previous session's messages and sub-sessions
        clearMessages();
        clearSubSessions();
      }

      send({
        type: 'create_session',
        config: {
          bundle: config.bundle,
          behaviors: config.behaviors,
          provider: config.provider,
          show_thinking: config.showThinking ?? true,
          initial_transcript: initialTranscript,
          cwd: config.cwd,
          resume_session_id: config.resumeSessionId,
        },
      });
    },
    [send, clearMessages, clearSubSessions, addMessage]
  );

  // Send prompt
  const sendPrompt = useCallback(
    (content: string, images?: string[]) => {
      setSession({ status: 'executing' });
      setStreaming(true);

      // Add user message immediately
      addMessage({
        id: generateUUID(),
        role: 'user',
        content: [{ type: 'text', content }],
        timestamp: new Date(),
      });

      send({
        type: 'prompt',
        content,
        images,
      });
    },
    [send, setSession, setStreaming, addMessage]
  );

  // Send approval response
  const sendApproval = useCallback(
    (id: string, choice: string) => {
      send({
        type: 'approval_response',
        id,
        choice,
      });
      setPendingApproval(null);
    },
    [send, setPendingApproval]
  );

  // Cancel execution
  const cancel = useCallback(
    (immediate = false) => {
      send({
        type: 'cancel',
        immediate,
      });
    },
    [send]
  );

  // Send command
  const sendCommand = useCallback(
    (name: string, args: string[] = []) => {
      send({
        type: 'command',
        name,
        args,
      });
    },
    [send]
  );

  // Get auth state for dependency
  const { isAuthenticated } = useAuthStore();

  // Auto-connect when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      connect();
    }
    return () => {
      disconnect();
    };
  }, [isAuthenticated, connect, disconnect]);

  return {
    isConnected,
    connect,
    disconnect,
    createSession,
    sendPrompt,
    sendApproval,
    cancel,
    sendCommand,
  };
}
