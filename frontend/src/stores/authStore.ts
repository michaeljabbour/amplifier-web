/**
 * Authentication store for Amplifier Web.
 *
 * Manages auth token storage and authentication state.
 * Token is stored in localStorage for persistence across visits.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthStore {
  // State
  token: string | null;
  isAuthenticated: boolean;
  isVerifying: boolean;
  error: string | null;

  // Actions
  setToken: (token: string) => void;
  clearToken: () => void;
  setVerifying: (verifying: boolean) => void;
  setError: (error: string | null) => void;
  setAuthenticated: (authenticated: boolean) => void;

  // API helpers
  getAuthHeaders: () => HeadersInit;
  verifyToken: () => Promise<boolean>;
}

// Determine the API base URL
const getApiBaseUrl = () => {
  // In development, use current origin
  // In production with HTTPS, use same origin
  return '';
};

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      // Initial state
      token: null,
      isAuthenticated: false,
      isVerifying: false,
      error: null,

      // Actions
      setToken: (token) => set({ token, error: null }),

      clearToken: () => set({ token: null, isAuthenticated: false, error: null }),

      setVerifying: (verifying) => set({ isVerifying: verifying }),

      setError: (error) => set({ error }),

      setAuthenticated: (authenticated) => set({ isAuthenticated: authenticated }),

      // Get authorization headers for API requests
      getAuthHeaders: () => {
        const { token } = get();
        if (!token) return {} as HeadersInit;
        return {
          'Authorization': `Bearer ${token}`,
        } as HeadersInit;
      },

      // Verify the current token with the server
      verifyToken: async () => {
        const { token } = get();
        if (!token) {
          set({ isAuthenticated: false });
          return false;
        }

        set({ isVerifying: true, error: null });

        try {
          const response = await fetch(`${getApiBaseUrl()}/api/auth/verify`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          });

          if (response.ok) {
            set({ isAuthenticated: true, isVerifying: false });
            return true;
          } else {
            const data = await response.json().catch(() => ({}));
            set({
              isAuthenticated: false,
              isVerifying: false,
              error: data.detail || 'Invalid token',
            });
            return false;
          }
        } catch (error) {
          set({
            isAuthenticated: false,
            isVerifying: false,
            error: 'Failed to verify token',
          });
          return false;
        }
      },
    }),
    {
      name: 'amplifier-auth',
      partialize: (state) => ({ token: state.token }),
    }
  )
);

// Helper function for making authenticated API requests
export async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const { token } = useAuthStore.getState();

  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  // If unauthorized, clear the token
  if (response.status === 401) {
    useAuthStore.getState().clearToken();
  }

  return response;
}
