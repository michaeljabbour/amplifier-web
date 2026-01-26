/**
 * Individual message bubble with content blocks.
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Message, ContentBlock, ToolCall, SubSession } from '../../types/amplifier';
import { useSessionStore } from '../../stores/sessionStore';

interface MessageBubbleProps {
  message: Message;
}

// Item that can be either content or tool call, for chronological rendering
type TimelineItem =
  | { kind: 'content'; block: ContentBlock; order: number }
  | { kind: 'tool'; toolCall: ToolCall; order: number };

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  // System messages get special styling (centered, warning style)
  if (isSystem) {
    return (
      <div className="flex justify-center my-4">
        <div className="max-w-[90%] bg-amber-900/30 border border-amber-700/50 text-amber-200 rounded-lg px-4 py-3">
          <div className="flex items-start gap-2">
            <span className="text-amber-400 mt-0.5">⚠️</span>
            <div className="space-y-2">
              {message.content.map((block, index) =>
                block ? (
                  <div key={index} className="text-sm">
                    <ReactMarkdown
                      components={{
                        p: ({ children }) => <p className="text-amber-200">{children}</p>,
                        strong: ({ children }) => <strong className="text-amber-100 font-semibold">{children}</strong>,
                        code: ({ children }) => <code className="bg-amber-900/50 px-1 py-0.5 rounded text-xs">{children}</code>,
                      }}
                    >
                      {block.content}
                    </ReactMarkdown>
                  </div>
                ) : null
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // For assistant messages, merge content and tool calls by order for chronological display
  const timelineItems: TimelineItem[] = [];

  if (!isUser) {
    // Add content blocks with their order (or array index as fallback)
    message.content.forEach((block, index) => {
      if (block) {
        timelineItems.push({
          kind: 'content',
          block,
          order: block.order ?? index,
        });
      }
    });

    // Add tool calls with their order (or high number as fallback to appear at end)
    if (message.toolCalls) {
      message.toolCalls.forEach((toolCall, index) => {
        timelineItems.push({
          kind: 'tool',
          toolCall,
          order: toolCall.order ?? (1000 + index),
        });
      });
    }

    // Sort by order for chronological display
    timelineItems.sort((a, b) => a.order - b.order);
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] ${
          isUser
            ? 'bg-amplifier-600 text-white rounded-2xl rounded-br-md'
            : 'bg-gray-800 text-gray-100 rounded-2xl rounded-bl-md'
        } px-4 py-3`}
      >
        {/* Role indicator */}
        <div className="text-xs text-gray-400 mb-1">
          {isUser ? 'You' : 'Amplifier'}
        </div>

        {/* User messages: just show content */}
        {isUser && (
          <div className="space-y-3">
            {message.content.map((block, index) =>
              block ? <ContentBlockView key={index} block={block} /> : null
            )}
          </div>
        )}

        {/* Assistant messages: interleaved timeline */}
        {!isUser && (
          <div className="space-y-3">
            {timelineItems.map((item, index) =>
              item.kind === 'content' ? (
                <ContentBlockView key={`content-${index}`} block={item.block} />
              ) : (
                <ToolCallView key={`tool-${item.toolCall.id}`} toolCall={item.toolCall} />
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ContentBlockView({ block, nested = false }: { block: ContentBlock; nested?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (block.type === 'thinking') {
    // Generate a preview of the thinking content
    const preview = block.content.trim();
    const truncatedPreview = preview.length > 60 ? preview.substring(0, 60) + '...' : preview;

    return (
      <div className={`${nested ? 'text-xs' : 'text-sm'} bg-gray-700/50 rounded overflow-hidden`}>
        {/* Header - matches tool call styling */}
        <button
          onClick={() => setExpanded(!expanded)}
          className={`w-full ${nested ? 'px-2 py-1' : 'px-3 py-2'} flex items-center gap-2 hover:bg-gray-700/50 transition-colors text-left`}
        >
          <span className="text-gray-500">{expanded ? '▼' : '▶'}</span>
          <span className="text-purple-400">💭</span>
          <span className="text-purple-400 font-medium">Thinking</span>
          {!expanded && preview && (
            <span className="text-gray-400 truncate flex-1 text-xs">
              {truncatedPreview}
            </span>
          )}
          {block.isStreaming && (
            <span className="text-yellow-400 text-xs">●</span>
          )}
        </button>

        {/* Expanded content - render with markdown like regular text */}
        {expanded && (
          <div className={`${nested ? 'px-2 pb-1' : 'px-3 pb-2'}`}>
            <div className={`prose max-w-none prose-sm ${nested ? 'text-gray-400' : 'text-gray-300'} bg-gray-900/50 p-2 rounded max-h-64 overflow-y-auto`}>
              <ReactMarkdown
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '');
                    const isInline = !match;
                    return isInline ? (
                      <code className="bg-gray-700 px-1 py-0.5 rounded text-xs" {...props}>
                        {children}
                      </code>
                    ) : (
                      <pre className="bg-gray-800 p-2 rounded-lg overflow-x-auto">
                        <code className={className} {...props}>
                          {children}
                        </code>
                      </pre>
                    );
                  },
                  a({ children, ...props }) {
                    return (
                      <a {...props} target="_blank" rel="noopener noreferrer" className="text-amplifier-400 hover:underline">
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {block.content}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (block.type === 'tool_use' || block.type === 'tool_result') {
    return (
      <div className={`bg-gray-700/30 rounded ${nested ? 'px-2 py-1' : 'px-3 py-2'} font-mono ${nested ? 'text-xs' : 'text-sm'}`}>
        <pre className="whitespace-pre-wrap overflow-x-auto">{block.content}</pre>
      </div>
    );
  }

  // Text content with markdown
  // Only show streaming cursor if there's actual content starting to appear
  const showCursor = block.isStreaming && block.content && block.content.length > 0;
  // Nested content uses gray text to be less prominent
  const textColorClass = nested ? 'text-gray-400' : '';
  return (
    <div className={`prose max-w-none ${nested ? 'prose-sm' : ''} ${textColorClass} ${showCursor ? 'streaming-cursor' : ''}`}>
      <ReactMarkdown
        components={{
          // Custom code block styling
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match;
            return isInline ? (
              <code className={`bg-gray-700 px-1 py-0.5 rounded ${nested ? 'text-xs text-gray-400' : 'text-sm'}`} {...props}>
                {children}
              </code>
            ) : (
              <pre className={`bg-gray-900 ${nested ? 'p-2' : 'p-4'} rounded-lg overflow-x-auto`}>
                <code className={`${className} ${nested ? 'text-gray-400' : ''}`} {...props}>
                  {children}
                </code>
              </pre>
            );
          },
          // Links open in new tab
          a({ children, ...props }) {
            return (
              <a {...props} target="_blank" rel="noopener noreferrer" className="text-amplifier-400 hover:underline">
                {children}
              </a>
            );
          },
          // Paragraphs inherit gray color for nested
          p({ children, ...props }) {
            return (
              <p className={nested ? 'text-gray-400' : ''} {...props}>
                {children}
              </p>
            );
          },
        }}
      >
        {block.content}
      </ReactMarkdown>
    </div>
  );
}

function ToolCallView({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const subSessions = useSessionStore((state) => state.subSessions);

  // Check if this tool call has an associated sub-session
  const subSession = subSessions.get(toolCall.id);
  const hasSubSession = !!subSession;

  const statusIcon = {
    pending: '⏳',
    running: '⏳',
    complete: '✓',
    error: '✗',
  }[toolCall.status] || '?';

  const statusColor = {
    pending: 'text-yellow-400',
    running: 'text-yellow-400',
    complete: 'text-green-400',
    error: 'text-red-400',
  }[toolCall.status] || 'text-gray-400';

  // Generate user-friendly preview based on tool type
  const getToolPreview = (name: string, args: Record<string, unknown>): string => {
    const truncate = (s: string, max: number) => s.length > max ? s.substring(0, max) + '...' : s;

    switch (name) {
      case 'bash':
        return truncate(String(args.command || ''), 80);

      case 'read_file':
        return String(args.file_path || args.path || '');

      case 'write_file':
        return `Writing to ${args.file_path || args.path || 'file'}`;

      case 'edit_file':
        return `Editing ${args.file_path || args.path || 'file'}`;

      case 'glob':
        return `Finding ${args.pattern || '*'} files`;

      case 'grep':
        const path = args.path ? ` in ${args.path}` : '';
        return `Searching for "${truncate(String(args.pattern || ''), 30)}"${path}`;

      case 'todo': {
        const action = args.action || 'manage';
        const todos = args.todos as Array<unknown> | undefined;
        const count = todos?.length || 0;
        if (action === 'create') return `Creating ${count} task${count !== 1 ? 's' : ''}`;
        if (action === 'update') return `Updating ${count} task${count !== 1 ? 's' : ''}`;
        if (action === 'clear') return 'Clearing tasks';
        return `${action} tasks`;
      }

      case 'task': {
        const agentName = String(args.agent || 'agent');
        // Show agent name prominently, then summary if sub-session exists
        return agentName;
      }

      case 'python_check': {
        const paths = args.paths as Array<string> | undefined;
        if (paths?.length === 1) return `Checking ${paths[0]}`;
        if (paths?.length) return `Checking ${paths.length} files`;
        return 'Running Python checks';
      }

      case 'web_search':
        return `Searching: "${truncate(String(args.query || ''), 50)}"`;

      case 'web_fetch':
        return truncate(String(args.url || ''), 60);

      case 'recipes':
        return args.recipe ? `Running recipe: ${args.recipe}` : 'Running recipe';

      case 'load_skill':
        return `Loading skill: ${args.skill || args.name || 'unknown'}`;

      default: {
        // Fallback: show first meaningful argument value
        const entries = Object.entries(args);
        if (entries.length === 0) return '';
        const [key, value] = entries[0];
        const strValue = typeof value === 'string' ? value : JSON.stringify(value);
        return truncate(`${key}: ${strValue}`, 80);
      }
    }
  };

  // Format result for display
  const formatResult = (result: string | Record<string, unknown> | undefined) => {
    if (!result) return null;
    // Handle object results (like read_file which returns {file_path, content, ...})
    const strResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    const truncated = strResult.length > 500 ? strResult.substring(0, 500) + '...' : strResult;
    return (
      <pre className="mt-1 text-xs text-gray-300 bg-gray-900/50 p-2 rounded overflow-x-auto whitespace-pre-wrap">
        {truncated}
      </pre>
    );
  };

  // Generate sub-session summary for collapsed view
  const getSubSessionSummary = (session: SubSession): string => {
    const toolCount = session.toolCalls.length;
    const textBlocks = session.content.filter(b => b.type === 'text');

    if (session.status === 'running') {
      if (toolCount > 0) {
        const lastTool = session.toolCalls[session.toolCalls.length - 1];
        return `Running ${lastTool.name}...`;
      }
      return 'Agent working...';
    }

    // Completed - show summary
    const parts: string[] = [];
    if (toolCount > 0) {
      parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''}`);
    }
    if (textBlocks.length > 0) {
      // Get first non-empty text content as preview
      const preview = textBlocks.find(b => b.content.trim())?.content.trim() || '';
      if (preview) {
        const truncated = preview.length > 50 ? preview.substring(0, 50) + '...' : preview;
        parts.push(truncated);
      }
    }
    return parts.join(' · ') || 'Completed';
  };

  return (
    <div className="text-sm bg-gray-700/50 rounded overflow-hidden">
      {/* Header - always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-700/50 transition-colors text-left"
      >
        <span className="text-gray-500">{expanded ? '▼' : '▶'}</span>
        <span className={statusColor}>{statusIcon}</span>
        <span className="text-amplifier-400 font-medium">{toolCall.name}</span>
        {/* For task tools, show agent name prominently */}
        {toolCall.name === 'task' && toolCall.arguments?.agent != null && (
          <span className="text-purple-400 font-medium text-xs">
            {String(toolCall.arguments.agent as string)}
          </span>
        )}
        {!expanded && (
          <span className="text-gray-400 truncate flex-1 font-mono text-xs">
            {hasSubSession && subSession
              ? getSubSessionSummary(subSession)
              : toolCall.name !== 'task' && toolCall.arguments && getToolPreview(toolCall.name, toolCall.arguments)}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {/* Sub-session content - only when expanded */}
          {hasSubSession && subSession && (
            <SubSessionView subSession={subSession} />
          )}

          {/* Arguments (hide for task tool with sub-session since it's verbose) */}
          {toolCall.arguments && Object.keys(toolCall.arguments).length > 0 && !(hasSubSession && toolCall.name === 'task') && (
            <div>
              <div className="text-xs text-gray-500 mb-1">Arguments:</div>
              <pre className="text-xs text-gray-300 bg-gray-900/50 p-2 rounded overflow-x-auto">
                {JSON.stringify(toolCall.arguments, null, 2)}
              </pre>
            </div>
          )}

          {/* Result (hide for task tool with sub-session since we show the conversation) */}
          {toolCall.result && !(hasSubSession && toolCall.name === 'task') && (
            <div>
              <div className="text-xs text-gray-500 mb-1">Result:</div>
              {formatResult(toolCall.result)}
            </div>
          )}

          {/* Error */}
          {toolCall.error && (
            <div>
              <div className="text-xs text-red-500 mb-1">Error:</div>
              <pre className="text-xs text-red-300 bg-red-900/20 p-2 rounded overflow-x-auto">
                {typeof toolCall.error === 'string'
                  ? toolCall.error
                  : JSON.stringify(toolCall.error, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders nested sub-session content inside a tool call card.
 */
function SubSessionView({ subSession }: { subSession: SubSession }) {
  // Merge content and tool calls by order for chronological display
  type SubSessionItem =
    | { kind: 'content'; block: ContentBlock; order: number }
    | { kind: 'tool'; toolCall: ToolCall; order: number };

  const items: SubSessionItem[] = [];

  subSession.content.forEach((block, index) => {
    if (block) {
      items.push({
        kind: 'content',
        block,
        order: block.order ?? index,
      });
    }
  });

  subSession.toolCalls.forEach((toolCall, index) => {
    items.push({
      kind: 'tool',
      toolCall,
      order: toolCall.order ?? (1000 + index),
    });
  });

  items.sort((a, b) => a.order - b.order);

  const statusIcon = {
    running: '⟳',
    complete: '✓',
    error: '✗',
  }[subSession.status];

  const statusColor = {
    running: 'text-yellow-500/70',
    complete: 'text-green-500/70',
    error: 'text-red-500/70',
  }[subSession.status];

  return (
    <div className="ml-4 border-l-2 border-gray-600/30 pl-3 py-2 my-2">
      {/* Agent header with status */}
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
        <span className={statusColor}>{statusIcon}</span>
        <span>Agent: {subSession.agent || 'sub-agent'}</span>
      </div>

      {/* Sub-session content */}
      <div className="space-y-2">
        {items.map((item, index) =>
          item.kind === 'content' ? (
            <ContentBlockView key={`sub-content-${index}`} block={item.block} nested />
          ) : (
            <NestedToolCallView key={`sub-tool-${item.toolCall.id}`} toolCall={item.toolCall} />
          )
        )}
      </div>
    </div>
  );
}

/**
 * Simplified tool call view for nested sub-session tool calls.
 * Uses muted colors to visually distinguish from main session.
 */
function NestedToolCallView({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    pending: '⏳',
    running: '⏳',
    complete: '✓',
    error: '✗',
  }[toolCall.status] || '?';

  // Muted status colors for nested tools
  const statusColor = {
    pending: 'text-yellow-500/70',
    running: 'text-yellow-500/70',
    complete: 'text-green-500/70',
    error: 'text-red-500/70',
  }[toolCall.status] || 'text-gray-500';

  const truncate = (s: string, max: number) => s.length > max ? s.substring(0, max) + '...' : s;

  const getToolPreview = (name: string, args: Record<string, unknown>): string => {
    switch (name) {
      case 'bash':
        return truncate(String(args.command || ''), 60);
      case 'read_file':
        return String(args.file_path || args.path || '');
      case 'glob':
        return `Finding ${args.pattern || '*'} files`;
      case 'grep':
        return `Searching "${truncate(String(args.pattern || ''), 20)}"`;
      default: {
        const entries = Object.entries(args);
        if (entries.length === 0) return '';
        const [, value] = entries[0];
        const strValue = typeof value === 'string' ? value : JSON.stringify(value);
        return truncate(strValue, 60);
      }
    }
  };

  return (
    <div className="text-xs bg-gray-700/20 rounded overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-2 py-1 flex items-center gap-1 hover:bg-gray-700/30 transition-colors text-left"
      >
        <span className="text-gray-600">{expanded ? '▼' : '▶'}</span>
        <span className={statusColor}>{statusIcon}</span>
        <span className="text-amplifier-400/70 font-medium">{toolCall.name}</span>
        {!expanded && toolCall.arguments && (
          <span className="text-gray-500 truncate flex-1 font-mono">
            {getToolPreview(toolCall.name, toolCall.arguments)}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-2 pb-1 space-y-1">
          {toolCall.result && (
            <pre className="text-xs text-gray-400 bg-gray-900/30 p-1 rounded overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
              {typeof toolCall.result === 'string'
                ? toolCall.result.substring(0, 300)
                : JSON.stringify(toolCall.result, null, 2).substring(0, 300)}
              {(typeof toolCall.result === 'string' ? toolCall.result.length : JSON.stringify(toolCall.result).length) > 300 && '...'}
            </pre>
          )}
          {toolCall.error && (
            <pre className="text-xs text-red-400/70 bg-red-900/10 p-1 rounded">
              {typeof toolCall.error === 'string' ? toolCall.error : JSON.stringify(toolCall.error)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
