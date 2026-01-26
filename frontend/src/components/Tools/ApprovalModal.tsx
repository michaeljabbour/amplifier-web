/**
 * Modal for tool approval requests.
 */

import { useEffect, useState } from 'react';
import type { ApprovalRequest } from '../../types/amplifier';

interface ApprovalModalProps {
  approval: ApprovalRequest;
  onResponse: (choice: string) => void;
}

export function ApprovalModal({ approval, onResponse }: ApprovalModalProps) {
  const [remainingTime, setRemainingTime] = useState(approval.timeout);

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setRemainingTime((prev) => {
        if (prev <= 1) {
          // Timeout - apply default
          onResponse(approval.default === 'allow' ? approval.options[0] : approval.options[approval.options.length - 1]);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [approval, onResponse]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Determine button styles based on option
  const getButtonStyle = (option: string) => {
    const lower = option.toLowerCase();
    if (lower.includes('deny') || lower.includes('no')) {
      return 'bg-red-600 hover:bg-red-700';
    }
    if (lower.includes('always')) {
      return 'bg-green-600 hover:bg-green-700';
    }
    return 'bg-amplifier-600 hover:bg-amplifier-700';
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="bg-yellow-600/20 border-b border-yellow-600/30 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <h2 className="text-lg font-semibold text-white">Approval Required</h2>
              <div className="text-sm text-yellow-300">
                Action requires your permission
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          <p className="text-gray-200 whitespace-pre-wrap">{approval.prompt}</p>

          {/* Timer */}
          <div className="mt-4 flex items-center gap-2">
            <div className="flex-1 bg-gray-700 rounded-full h-2 overflow-hidden">
              <div
                className="bg-yellow-500 h-full transition-all duration-1000"
                style={{ width: `${(remainingTime / approval.timeout) * 100}%` }}
              />
            </div>
            <span className="text-sm text-gray-400 w-12 text-right">
              {formatTime(remainingTime)}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Default: {approval.default} on timeout
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 bg-gray-900/50 flex flex-wrap gap-3 justify-end">
          {approval.options.map((option) => (
            <button
              key={option}
              onClick={() => onResponse(option)}
              className={`px-4 py-2 rounded-lg text-white font-medium transition-colors ${getButtonStyle(option)}`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
