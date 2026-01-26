/**
 * Card displaying a tool call and its result.
 */

import { useState } from 'react';
import type { ToolCall } from '../../types/amplifier';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    pending: '⏳',
    running: '🔄',
    complete: '✅',
    error: '❌',
  }[toolCall.status];

  const statusColor = {
    pending: 'text-yellow-400',
    running: 'text-blue-400',
    complete: 'text-green-400',
    error: 'text-red-400',
  }[toolCall.status];

  return (
    <div className="bg-gray-700/50 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-700/70 transition-colors"
      >
        <span className={statusColor}>{statusIcon}</span>
        <span className="font-medium text-amplifier-400">{toolCall.name}</span>
        <span className="text-gray-500 text-sm flex-1 text-left truncate">
          {JSON.stringify(toolCall.arguments).slice(0, 50)}...
        </span>
        <span className="text-gray-400">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Arguments */}
          <div>
            <div className="text-xs text-gray-400 mb-1">Arguments</div>
            <pre className="bg-gray-900 p-3 rounded text-sm overflow-x-auto">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {toolCall.result && (
            <div>
              <div className="text-xs text-gray-400 mb-1">Result</div>
              <pre className="bg-gray-900 p-3 rounded text-sm overflow-x-auto max-h-60">
                {typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}

          {/* Error */}
          {toolCall.error && (
            <div>
              <div className="text-xs text-red-400 mb-1">Error</div>
              <pre className="bg-red-900/30 p-3 rounded text-sm text-red-300">
                {typeof toolCall.error === 'string' ? toolCall.error : JSON.stringify(toolCall.error, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
