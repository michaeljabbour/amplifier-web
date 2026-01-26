/**
 * Input area for sending messages.
 */

import { useState, useRef, useCallback, KeyboardEvent } from 'react';

interface InputAreaProps {
  onSend: (content: string, images?: string[]) => void;
  onCancel: (immediate?: boolean) => void;
  isExecuting: boolean;
}

export function InputArea({ onSend, onCancel, isExecuting }: InputAreaProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (trimmed && !isExecuting) {
      // Check for slash commands
      if (trimmed.startsWith('/')) {
        // Handle locally for now (could send to server)
        console.log('Command:', trimmed);
      }
      onSend(trimmed);
      setInput('');

      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  }, [input, isExecuting, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInput = useCallback(() => {
    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, []);

  return (
    <div className="flex items-end gap-3">
      <div className="flex-1 relative">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            handleInput();
          }}
          onKeyDown={handleKeyDown}
          placeholder={isExecuting ? 'Waiting for response...' : 'Type a message... (Shift+Enter for new line)'}
          disabled={isExecuting}
          rows={1}
          className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg resize-none
                     focus:outline-none focus:border-amplifier-500 focus:ring-1 focus:ring-amplifier-500
                     disabled:opacity-50 disabled:cursor-not-allowed
                     placeholder-gray-400 text-gray-100"
        />

        {/* Character count */}
        {input.length > 1000 && (
          <span className="absolute bottom-2 right-2 text-xs text-gray-400">
            {input.length}
          </span>
        )}
      </div>

      {/* Send or Cancel button */}
      {isExecuting ? (
        <button
          onClick={() => onCancel(false)}
          className="px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg
                     transition-colors flex items-center gap-2"
        >
          <span>Cancel</span>
        </button>
      ) : (
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="px-4 py-3 bg-amplifier-600 hover:bg-amplifier-700 text-white rounded-lg
                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-2"
        >
          <span>Send</span>
          <kbd className="text-xs bg-amplifier-700 px-1.5 py-0.5 rounded">↵</kbd>
        </button>
      )}
    </div>
  );
}
