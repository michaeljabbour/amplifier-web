/**
 * Type definitions for Amplifier Web interface.
 * Maps to WebSocket protocol and session state.
 */

// ============================================================================
// WebSocket Message Types
// ============================================================================

/** Server -> Client messages */
export type ServerMessage =
  | SessionCreatedMessage
  | ContentStartMessage
  | ContentDeltaMessage
  | ContentEndMessage
  | ThinkingDeltaMessage
  | ThinkingFinalMessage
  | ToolCallMessage
  | ToolResultMessage
  | ApprovalRequestMessage
  | DisplayMessage
  | PromptCompleteMessage
  | ErrorMessage
  | CommandResultMessage
  | SessionForkMessage
  | PongMessage
  // Debug/diagnostic messages
  | BundleDebugInfoMessage
  | ProviderRequestMessage
  | ProviderResponseMessage
  | SessionStartMessage
  | SessionEndMessage
  | ContextCompactionMessage;

/** Client -> Server messages */
export type ClientMessage =
  | CreateSessionMessage
  | PromptMessage
  | ApprovalResponseMessage
  | CancelMessage
  | CommandMessage
  | PingMessage;

// Server messages
export interface SessionCreatedMessage {
  type: 'session_created';
  session_id: string;
  bundle: string;
  behaviors: string[];
  cwd?: string;
}

export interface ContentStartMessage {
  type: 'content_start';
  block_type: 'text' | 'thinking' | 'tool_use';
  index: number;
  // Sub-session context (present when forwarded from child session)
  child_session_id?: string;
  parent_tool_call_id?: string;
  nesting_depth?: number;
}

export interface ContentDeltaMessage {
  type: 'content_delta';
  index: number;
  delta: string;
  block_type?: string;
  // Sub-session context (present when forwarded from child session)
  child_session_id?: string;
  parent_tool_call_id?: string;
  nesting_depth?: number;
}

export interface ContentEndMessage {
  type: 'content_end';
  index: number;
  content: string;
  block_type?: string;
  // Sub-session context (present when forwarded from child session)
  child_session_id?: string;
  parent_tool_call_id?: string;
  nesting_depth?: number;
}

export interface ThinkingDeltaMessage {
  type: 'thinking_delta';
  delta: string;
}

export interface ThinkingFinalMessage {
  type: 'thinking_final';
  content: string;
}

export interface ToolCallMessage {
  type: 'tool_call';
  tool_name: string;
  tool_call_id: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'running' | 'complete' | 'error';
  // Sub-session context (present when forwarded from child session)
  child_session_id?: string;
  parent_tool_call_id?: string;
  nesting_depth?: number;
}

export interface ToolResultMessage {
  type: 'tool_result';
  tool_name: string;
  tool_call_id: string;
  output: string;
  success: boolean;
  error?: string;
  // Sub-session context (present when forwarded from child session)
  child_session_id?: string;
  parent_tool_call_id?: string;
  nesting_depth?: number;
}

export interface ApprovalRequestMessage {
  type: 'approval_request';
  id: string;
  prompt: string;
  options: string[];
  timeout: number;
  default: string;
}

export interface DisplayMessage {
  type: 'display_message';
  level: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
  nesting?: number;
}

export interface PromptCompleteMessage {
  type: 'prompt_complete';
  turn: number;
}

export interface ErrorMessage {
  type: 'error';
  error: string;
}

export interface CommandResultMessage {
  type: 'command_result';
  command: string;
  result: Record<string, unknown>;
}

export interface PongMessage {
  type: 'pong';
}

export interface SessionForkMessage {
  type: 'session_fork';
  parent_id: string;
  child_id: string;
  parent_tool_call_id?: string;
  agent?: string;
}

// Debug/diagnostic messages
export interface BundleDebugInfoMessage {
  type: 'bundle_debug_info';
  bundle_name: string;
  bundle_version: string;
  behaviors_composed: string[];
  instruction_length: number;
  instruction_preview?: string;
  tools: Array<{ module: string; config?: Record<string, unknown> }>;
  tools_count: number;
  providers: Array<{ module: string; config?: Record<string, unknown> }>;
  providers_count: number;
  hooks: Array<{ module: string; events?: string[] }>;
  hooks_count: number;
  agents: Record<string, { instruction?: string; tools?: string[] }>;
  agents_count: number;
  mount_plan?: { modules?: string[]; providers?: string[]; error?: string };
}

export interface ProviderRequestMessage {
  type: 'provider_request';
  provider: string;
  model: string;
  message_count: number;
  messages: Array<{ role?: string; content?: unknown }>;
  tools?: string[];
  system_prompt_length?: number;
}

export interface ProviderResponseMessage {
  type: 'provider_response';
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  finish_reason?: string;
  stop_reason?: string;
  content_blocks?: number;
  content?: Array<{ type?: string; text?: string }>;
}

export interface SessionStartMessage {
  type: 'session_start';
  session_id: string;
  parent_id?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionEndMessage {
  type: 'session_end';
  session_id: string;
  status: string;
}

export interface ContextCompactionMessage {
  type: 'context_compaction';
  before_tokens?: number;
  after_tokens?: number;
}

// Client messages
export interface CreateSessionMessage {
  type: 'create_session';
  config: {
    bundle?: string;
    behaviors?: string[];
    provider?: Record<string, unknown>;
    show_thinking?: boolean;
    initial_transcript?: Array<{ role: string; content: unknown }>;
    cwd?: string;  // Working directory for file operations
    resume_session_id?: string;  // Session ID to resume (loads transcript from storage)
  };
}

export interface PromptMessage {
  type: 'prompt';
  content: string;
  images?: string[];
}

export interface ApprovalResponseMessage {
  type: 'approval_response';
  id: string;
  choice: string;
}

export interface CancelMessage {
  type: 'cancel';
  immediate?: boolean;
}

export interface CommandMessage {
  type: 'command';
  name: string;
  args: string[];
}

export interface PingMessage {
  type: 'ping';
}

// ============================================================================
// Application State Types
// ============================================================================

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  content: string;
  isStreaming?: boolean;
  order?: number;  // Insertion order for chronological rendering
}

export interface Message {
  id: string;
  role: MessageRole;
  content: ContentBlock[];
  timestamp: Date;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'running' | 'complete' | 'error';
  result?: string | Record<string, unknown>;
  error?: string | Record<string, unknown>;
  order?: number;  // Insertion order for chronological rendering
}

export interface ApprovalRequest {
  id: string;
  prompt: string;
  options: string[];
  timeout: number;
  default: string;
  remainingTime: number;
}

export interface SessionState {
  sessionId: string | null;
  bundle: string;
  behaviors: string[];
  status: 'disconnected' | 'connecting' | 'connected' | 'executing';
  turnCount: number;
  cwd?: string;  // Working directory
}

export interface BundleInfo {
  name: string;
  description: string;
  available: boolean;
  is_custom?: boolean;
  uri?: string;
}

// Sub-session state (for nested agent delegation)
export interface SubSession {
  sessionId: string;
  parentToolCallId: string;
  agent?: string;
  status: 'running' | 'complete' | 'error';
  content: ContentBlock[];
  toolCalls: ToolCall[];
}
