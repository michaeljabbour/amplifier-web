/**
 * Zustand store for session and message state.
 */

import { create } from 'zustand';
import type {
  Message,
  ContentBlock,
  ToolCall,
  ApprovalRequest,
  SessionState,
  SubSession,
} from '../types/amplifier';

interface SessionStore {
  // Session state
  session: SessionState;
  setSession: (update: Partial<SessionState>) => void;

  // Messages
  messages: Message[];
  addMessage: (message: Message) => void;
  updateLastAssistantMessage: (update: (blocks: ContentBlock[]) => ContentBlock[]) => void;
  addToolCallToLastMessage: (toolCall: ToolCall) => void;
  updateToolCallInLastMessage: (id: string, update: Partial<ToolCall>) => void;
  clearMessages: () => void;

  // Streaming state
  isStreaming: boolean;
  setStreaming: (streaming: boolean) => void;
  currentBlockIndex: number;
  setCurrentBlockIndex: (index: number) => void;

  // Approvals
  pendingApproval: ApprovalRequest | null;
  setPendingApproval: (approval: ApprovalRequest | null) => void;
  updateApprovalTimer: (remainingTime: number) => void;

  // Display messages
  displayMessages: Array<{ level: string; message: string; source?: string }>;
  addDisplayMessage: (msg: { level: string; message: string; source?: string }) => void;
  clearDisplayMessages: () => void;

  // Sub-sessions (for nested agent delegation)
  subSessions: Map<string, SubSession>;
  startSubSession: (toolCallId: string, sessionId: string, agent?: string) => void;
  updateSubSessionContent: (toolCallId: string, update: (blocks: ContentBlock[]) => ContentBlock[]) => void;
  addSubSessionToolCall: (toolCallId: string, toolCall: ToolCall) => void;
  updateSubSessionToolCall: (toolCallId: string, tcId: string, update: Partial<ToolCall>) => void;
  endSubSession: (toolCallId: string, status: 'complete' | 'error') => void;
  clearSubSessions: () => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  // Session state
  session: {
    sessionId: null,
    bundle: 'foundation',
    behaviors: [],
    status: 'disconnected',
    turnCount: 0,
    cwd: undefined,
  },
  setSession: (update) =>
    set((state) => ({ session: { ...state.session, ...update } })),

  // Messages
  messages: [],
  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  updateLastAssistantMessage: (update) =>
    set((state) => {
      const messages: Message[] = [...state.messages];
      const lastIndex = messages.findLastIndex((m: Message) => m.role === 'assistant');
      if (lastIndex >= 0) {
        messages[lastIndex] = {
          ...messages[lastIndex],
          content: update(messages[lastIndex].content),
        };
      }
      return { messages };
    }),

  addToolCallToLastMessage: (toolCall: ToolCall) =>
    set((state) => {
      const messages: Message[] = [...state.messages];
      const lastIndex = messages.findLastIndex((m: Message) => m.role === 'assistant');
      if (lastIndex >= 0) {
        const existing = messages[lastIndex].toolCalls || [];
        messages[lastIndex] = {
          ...messages[lastIndex],
          toolCalls: [...existing, toolCall],
        };
      }
      return { messages };
    }),

  updateToolCallInLastMessage: (id: string, update: Partial<ToolCall>) =>
    set((state) => {
      const messages: Message[] = [...state.messages];
      const lastIndex = messages.findLastIndex((m: Message) => m.role === 'assistant');
      if (lastIndex >= 0 && messages[lastIndex].toolCalls) {
        messages[lastIndex] = {
          ...messages[lastIndex],
          toolCalls: messages[lastIndex].toolCalls!.map((tc) =>
            tc.id === id ? { ...tc, ...update } : tc
          ),
        };
      }
      return { messages };
    }),

  clearMessages: () => set({ messages: [] }),

  // Streaming state
  isStreaming: false,
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  currentBlockIndex: 0,
  setCurrentBlockIndex: (index) => set({ currentBlockIndex: index }),

  // Approvals
  pendingApproval: null,
  setPendingApproval: (approval) => set({ pendingApproval: approval }),
  updateApprovalTimer: (remainingTime) =>
    set((state) => ({
      pendingApproval: state.pendingApproval
        ? { ...state.pendingApproval, remainingTime }
        : null,
    })),

  // Display messages
  displayMessages: [],
  addDisplayMessage: (msg) =>
    set((state) => ({
      displayMessages: [...state.displayMessages.slice(-50), msg],
    })),
  clearDisplayMessages: () => set({ displayMessages: [] }),

  // Sub-sessions (for nested agent delegation)
  subSessions: new Map(),

  startSubSession: (toolCallId, sessionId, agent) =>
    set((state) => {
      const map = new Map(state.subSessions);
      map.set(toolCallId, {
        sessionId,
        parentToolCallId: toolCallId,
        agent,
        status: 'running',
        content: [],
        toolCalls: [],
      });
      return { subSessions: map };
    }),

  updateSubSessionContent: (toolCallId, update) =>
    set((state) => {
      const map = new Map(state.subSessions);
      const session = map.get(toolCallId);
      if (session) {
        map.set(toolCallId, {
          ...session,
          content: update(session.content),
        });
      }
      return { subSessions: map };
    }),

  addSubSessionToolCall: (toolCallId, toolCall) =>
    set((state) => {
      const map = new Map(state.subSessions);
      const session = map.get(toolCallId);
      if (session) {
        map.set(toolCallId, {
          ...session,
          toolCalls: [...session.toolCalls, toolCall],
        });
      }
      return { subSessions: map };
    }),

  updateSubSessionToolCall: (toolCallId, tcId, update) =>
    set((state) => {
      const map = new Map(state.subSessions);
      const session = map.get(toolCallId);
      if (session) {
        map.set(toolCallId, {
          ...session,
          toolCalls: session.toolCalls.map((tc) =>
            tc.id === tcId ? { ...tc, ...update } : tc
          ),
        });
      }
      return { subSessions: map };
    }),

  endSubSession: (toolCallId, status) =>
    set((state) => {
      const map = new Map(state.subSessions);
      const session = map.get(toolCallId);
      if (session) {
        map.set(toolCallId, {
          ...session,
          status,
        });
      }
      return { subSessions: map };
    }),

  clearSubSessions: () => set({ subSessions: new Map() }),
}));
