/**
 * Login modal for entering the auth token.
 * 
 * Automatically attempts to fetch the token from the local backend
 * when running on localhost, eliminating the need for manual entry.
 */

import { useState, useCallback, useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore';

interface LoginModalProps {
  onSuccess?: () => void;
}

export function LoginModal({ onSuccess }: LoginModalProps) {
  const { setToken, verifyToken, error, isVerifying, setError } = useAuthStore();
  const [inputToken, setInputToken] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [autoFetching, setAutoFetching] = useState(false);

  // Try to auto-fetch token from local backend on mount
  useEffect(() => {
    const tryAutoFetch = async () => {
      setAutoFetching(true);
      try {
        const response = await fetch('/api/auth/local-token');
        if (response.ok) {
          const data = await response.json();
          if (data.token) {
            // Auto-set and verify the token
            setToken(data.token);
            await new Promise(resolve => setTimeout(resolve, 50));
            const valid = await verifyToken();
            if (valid) {
              onSuccess?.();
              return;
            }
          }
        }
      } catch (e) {
        // Auto-fetch failed, user will need to enter manually
        console.log('Auto-fetch token not available, manual entry required');
      }
      setAutoFetching(false);
    };
    
    tryAutoFetch();
  }, [setToken, verifyToken, onSuccess]);

  // Clear errors when input changes
  useEffect(() => {
    setLocalError(null);
    setError(null);
  }, [inputToken, setError]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedToken = inputToken.trim();
    if (!trimmedToken) {
      setLocalError('Please enter a token');
      return;
    }

    // Set the token and verify it
    setToken(trimmedToken);

    // Small delay to ensure state is updated
    await new Promise(resolve => setTimeout(resolve, 50));

    const valid = await verifyToken();
    if (valid) {
      onSuccess?.();
    }
  }, [inputToken, setToken, verifyToken, onSuccess]);

  const displayError = localError || error;

  // Show loading while auto-fetching
  if (autoFetching) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-gray-800 rounded-lg shadow-2xl max-w-md w-full mx-4 p-6">
          <div className="text-center">
            <div className="animate-spin h-8 w-8 border-4 border-amplifier-500 border-t-transparent rounded-full mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-white mb-2">Connecting...</h2>
            <p className="text-gray-400">Authenticating with local server</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg shadow-2xl max-w-md w-full mx-4 p-6">
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-white mb-2">Amplifier Web</h2>
          <p className="text-gray-400">
            Enter your authentication token to continue.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="token" className="block text-sm font-medium text-gray-300 mb-2">
              Auth Token
            </label>
            <input
              type="password"
              id="token"
              value={inputToken}
              onChange={(e) => setInputToken(e.target.value)}
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amplifier-500 focus:border-transparent font-mono"
              placeholder="Enter your token"
              autoFocus
              autoComplete="off"
            />
          </div>

          {displayError && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-200 text-sm">
              {displayError}
            </div>
          )}

          <button
            type="submit"
            disabled={isVerifying}
            className="w-full py-3 bg-amplifier-600 hover:bg-amplifier-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors font-medium flex items-center justify-center gap-2"
          >
            {isVerifying ? (
              <>
                <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                Verifying...
              </>
            ) : (
              'Login'
            )}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-gray-700">
          <p className="text-xs text-gray-500 text-center">
            Find your token in the server startup output or in<br />
            <code className="bg-gray-700 px-1 py-0.5 rounded">~/.amplifier/web-auth.json</code>
          </p>
        </div>
      </div>
    </div>
  );
}
