/**
 * Main chat container with message list and input.
 */

import { useRef, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { MessageList } from './MessageList';
import { InputArea } from './InputArea';

interface ChatContainerProps {
  onSendMessage: (content: string, images?: string[]) => void;
  onCancel: (immediate?: boolean) => void;
  isExecuting: boolean;
}

export function ChatContainer({
  onSendMessage,
  onCancel,
  isExecuting,
}: ChatContainerProps) {
  const { messages, displayMessages } = useSessionStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-6"
      >
        <div className="max-w-4xl mx-auto">
          {messages.length === 0 ? (
            <WelcomeMessage />
          ) : (
            <MessageList messages={messages} />
          )}

          {/* Display messages (from hooks) */}
          {displayMessages.length > 0 && (
            <div className="mt-4 space-y-2">
              {displayMessages.slice(-5).map((msg, i) => (
                <div
                  key={i}
                  className={`text-sm px-3 py-2 rounded ${
                    msg.level === 'error'
                      ? 'bg-red-900/30 text-red-300'
                      : msg.level === 'warning'
                      ? 'bg-yellow-900/30 text-yellow-300'
                      : 'bg-blue-900/30 text-blue-300'
                  }`}
                >
                  {msg.source && (
                    <span className="text-gray-400">[{msg.source}] </span>
                  )}
                  {msg.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 border-t border-gray-700 bg-gray-800">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <InputArea
            onSend={onSendMessage}
            onCancel={onCancel}
            isExecuting={isExecuting}
          />
        </div>
      </div>
    </div>
  );
}

function WelcomeMessage() {
  return (
    <div className="text-center py-12">
      <h2 className="text-2xl font-semibold text-gray-200 mb-4">
        Welcome to Amplifier Web
      </h2>
      <p className="text-gray-400 mb-8 max-w-lg mx-auto">
        An AI-powered modular development assistant. Start by typing a message
        below or configure your bundle and behaviors.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl mx-auto">
        <SuggestionCard
          title="Code Review"
          description="Help me review this pull request"
        />
        <SuggestionCard
          title="Debug"
          description="I'm getting an error in my code"
        />
        <SuggestionCard
          title="Architecture"
          description="Design a system for..."
        />
      </div>
    </div>
  );
}

function SuggestionCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="p-4 bg-gray-800 rounded-lg border border-gray-700 hover:border-amplifier-500 cursor-pointer transition-colors">
      <h3 className="font-medium text-gray-200 mb-1">{title}</h3>
      <p className="text-sm text-gray-400">{description}</p>
    </div>
  );
}
