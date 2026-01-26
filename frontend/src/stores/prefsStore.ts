/**
 * Preferences store for Amplifier Web.
 *
 * Manages user preferences with server sync.
 * Preferences are stored on the server in ~/.amplifier/web-preferences.json.
 */

import { create } from 'zustand';
import { authFetch } from './authStore';

interface CustomBundle {
  uri: string;
  name: string;
  description: string;
}

interface CustomBehavior {
  uri: string;
  name: string;
  description: string;
}

interface PrefsStore {
  // State
  defaultBundle: string;
  defaultBehaviors: string[];
  showThinking: boolean;
  defaultCwd: string | null;
  customBundles: CustomBundle[];
  customBehaviors: CustomBehavior[];
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;

  // Actions
  setDefaultBundle: (bundle: string) => void;
  setDefaultBehaviors: (behaviors: string[]) => void;
  setShowThinking: (show: boolean) => void;
  setDefaultCwd: (cwd: string | null) => void;
  setCustomBundles: (bundles: CustomBundle[]) => void;
  setCustomBehaviors: (behaviors: CustomBehavior[]) => void;
  setError: (error: string | null) => void;

  // Server sync
  loadFromServer: () => Promise<void>;
  saveToServer: () => Promise<void>;

  // Custom bundle management
  addCustomBundle: (uri: string, name?: string, description?: string) => Promise<{ success: boolean; error?: string }>;
  removeCustomBundle: (name: string) => Promise<{ success: boolean; error?: string }>;
  validateBundleUri: (uri: string) => Promise<{ valid: boolean; error?: string; bundleInfo?: Record<string, unknown> }>;

  // Custom behavior management
  addCustomBehavior: (uri: string, name?: string, description?: string) => Promise<{ success: boolean; error?: string }>;
  removeCustomBehavior: (name: string) => Promise<{ success: boolean; error?: string }>;
}

export const usePrefsStore = create<PrefsStore>((set, get) => ({
  // Initial state (will be overwritten by server)
  defaultBundle: 'foundation',
  defaultBehaviors: ['sessions'],  // Sessions behavior enables auto-naming
  showThinking: true,
  defaultCwd: null,
  customBundles: [],
  customBehaviors: [],
  isLoading: false,
  isSaving: false,
  error: null,

  // Local setters
  setDefaultBundle: (bundle) => set({ defaultBundle: bundle }),
  setDefaultBehaviors: (behaviors) => set({ defaultBehaviors: behaviors }),
  setDefaultCwd: (cwd) => set({ defaultCwd: cwd }),
  setShowThinking: (show) => set({ showThinking: show }),
  setCustomBundles: (bundles) => set({ customBundles: bundles }),
  setCustomBehaviors: (behaviors) => set({ customBehaviors: behaviors }),
  setError: (error) => set({ error }),

  // Load preferences from server
  loadFromServer: async () => {
    set({ isLoading: true, error: null });

    try {
      const response = await authFetch('/api/preferences');

      if (response.ok) {
        const data = await response.json();
        set({
          defaultBundle: data.default_bundle || 'foundation',
          defaultBehaviors: data.default_behaviors || ['sessions'],
          showThinking: data.show_thinking ?? true,
          defaultCwd: data.default_cwd || null,
          customBundles: data.custom_bundles || [],
          customBehaviors: data.custom_behaviors || [],
          isLoading: false,
        });
      } else {
        const errorData = await response.json().catch(() => ({}));
        set({
          isLoading: false,
          error: errorData.detail || 'Failed to load preferences',
        });
      }
    } catch (error) {
      set({
        isLoading: false,
        error: 'Failed to load preferences',
      });
    }
  },

  // Save preferences to server
  saveToServer: async () => {
    const { defaultBundle, defaultBehaviors, showThinking, defaultCwd } = get();

    set({ isSaving: true, error: null });

    try {
      const response = await authFetch('/api/preferences', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          default_bundle: defaultBundle,
          default_behaviors: defaultBehaviors,
          show_thinking: showThinking,
          default_cwd: defaultCwd,
        }),
      });

      if (response.ok) {
        set({ isSaving: false });
      } else {
        const errorData = await response.json().catch(() => ({}));
        set({
          isSaving: false,
          error: errorData.detail || 'Failed to save preferences',
        });
      }
    } catch (error) {
      set({
        isSaving: false,
        error: 'Failed to save preferences',
      });
    }
  },

  // Add a custom bundle
  addCustomBundle: async (uri, name, description) => {
    try {
      const response = await authFetch('/api/bundles/custom', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uri, name, description }),
      });

      if (response.ok) {
        // Reload preferences to get updated custom bundles list
        await get().loadFromServer();
        return { success: true };
      } else {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: errorData.detail || 'Failed to add bundle' };
      }
    } catch (error) {
      return { success: false, error: 'Failed to add bundle' };
    }
  },

  // Remove a custom bundle
  removeCustomBundle: async (name) => {
    try {
      const response = await authFetch(`/api/bundles/custom/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        // Reload preferences to get updated custom bundles list
        await get().loadFromServer();
        return { success: true };
      } else {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: errorData.detail || 'Failed to remove bundle' };
      }
    } catch (error) {
      return { success: false, error: 'Failed to remove bundle' };
    }
  },

  // Validate a bundle URI without adding it
  validateBundleUri: async (uri) => {
    try {
      const response = await authFetch('/api/bundles/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uri }),
      });

      if (response.ok) {
        const data = await response.json();
        return {
          valid: data.valid,
          error: data.error,
          bundleInfo: data.bundle_info,
        };
      } else {
        const errorData = await response.json().catch(() => ({}));
        return { valid: false, error: errorData.detail || 'Validation failed' };
      }
    } catch (error) {
      return { valid: false, error: 'Validation failed' };
    }
  },

  // Add a custom behavior
  addCustomBehavior: async (uri, name, description) => {
    try {
      const response = await authFetch('/api/behaviors/custom', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uri, name, description }),
      });

      if (response.ok) {
        // Reload preferences to get updated custom behaviors list
        await get().loadFromServer();
        return { success: true };
      } else {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: errorData.detail || 'Failed to add behavior' };
      }
    } catch (error) {
      return { success: false, error: 'Failed to add behavior' };
    }
  },

  // Remove a custom behavior
  removeCustomBehavior: async (name) => {
    try {
      const response = await authFetch(`/api/behaviors/custom/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        // Reload preferences to get updated custom behaviors list
        await get().loadFromServer();
        return { success: true };
      } else {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: errorData.detail || 'Failed to remove behavior' };
      }
    } catch (error) {
      return { success: false, error: 'Failed to remove behavior' };
    }
  },
}));
