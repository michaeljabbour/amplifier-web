/**
 * Configuration panel for bundle and behavior selection.
 */

import { useState, useEffect, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { usePrefsStore } from '../../stores/prefsStore';
import { authFetch } from '../../stores/authStore';
import type { BundleInfo } from '../../types/amplifier';

interface ConfigPanelProps {
  onClose: () => void;
  onCreateSession: (config: {
    bundle?: string;
    behaviors?: string[];
    showThinking?: boolean;
    keepHistory?: boolean;
    previousBundle?: string;
    previousBehaviors?: string[];
    cwd?: string;
  }) => void;
}

interface BehaviorInfo {
  name: string;
  description: string;
  is_custom?: boolean;
  uri?: string;
}

export function ConfigPanel({ onClose, onCreateSession }: ConfigPanelProps) {
  const { session } = useSessionStore();
  const {
    defaultBundle,
    defaultBehaviors,
    showThinking: prefsShowThinking,
    defaultCwd: prefsDefaultCwd,
    addCustomBundle,
    removeCustomBundle,
    addCustomBehavior,
    removeCustomBehavior,
    validateBundleUri,
    loadFromServer,
    saveToServer,
  } = usePrefsStore();

  // Local state
  const [bundles, setBundles] = useState<BundleInfo[]>([]);
  const [behaviors, setBehaviors] = useState<BehaviorInfo[]>([]);
  const [selectedBundle, setSelectedBundle] = useState(session.bundle || defaultBundle);
  const [selectedBehaviors, setSelectedBehaviors] = useState<string[]>(
    session.behaviors.length > 0 ? session.behaviors : defaultBehaviors
  );
  const [showThinking, setShowThinking] = useState(prefsShowThinking);
  const [workingDir, setWorkingDir] = useState(session.cwd || '');

  // Custom bundle input
  const [showAddBundleForm, setShowAddBundleForm] = useState(false);
  const [customBundleUri, setCustomBundleUri] = useState('');
  const [isBundleValidating, setIsBundleValidating] = useState(false);
  const [isBundleAdding, setIsBundleAdding] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [bundleValidationResult, setBundleValidationResult] = useState<{
    valid: boolean;
    bundleInfo?: Record<string, unknown>;
  } | null>(null);

  // Custom behavior input
  const [showAddBehaviorForm, setShowAddBehaviorForm] = useState(false);
  const [customBehaviorUri, setCustomBehaviorUri] = useState('');
  const [isBehaviorValidating, setIsBehaviorValidating] = useState(false);
  const [isBehaviorAdding, setIsBehaviorAdding] = useState(false);
  const [behaviorError, setBehaviorError] = useState<string | null>(null);
  const [behaviorValidationResult, setBehaviorValidationResult] = useState<{
    valid: boolean;
    bundleInfo?: Record<string, unknown>;
  } | null>(null);

  // Load bundles and behaviors from API
  useEffect(() => {
    const loadData = async () => {
      try {
        const [bundlesRes, behaviorsRes] = await Promise.all([
          authFetch('/api/bundles'),
          authFetch('/api/behaviors'),
        ]);
        if (bundlesRes.ok) {
          setBundles(await bundlesRes.json());
        }
        if (behaviorsRes.ok) {
          setBehaviors(await behaviorsRes.json());
        }
      } catch (error) {
        console.error('Failed to load data:', error);
      }
    };

    loadData();
    loadFromServer();
  }, [loadFromServer]);

  // Sync with preferences when they change
  useEffect(() => {
    if (!session.sessionId) {
      setSelectedBundle(defaultBundle);
      setSelectedBehaviors(defaultBehaviors);
      setShowThinking(prefsShowThinking);
      setWorkingDir(prefsDefaultCwd || '');
    }
  }, [defaultBundle, defaultBehaviors, prefsShowThinking, prefsDefaultCwd, session.sessionId]);

  const toggleBehavior = (name: string) => {
    setSelectedBehaviors((prev) =>
      prev.includes(name) ? prev.filter((b) => b !== name) : [...prev, name]
    );
  };

  const handleApply = (keepHistory = false) => {
    onCreateSession({
      bundle: selectedBundle,
      behaviors: selectedBehaviors.length > 0 ? selectedBehaviors : undefined,
      showThinking,
      keepHistory,
      // Pass previous config for reconfigure notification
      previousBundle: keepHistory ? session.bundle : undefined,
      previousBehaviors: keepHistory ? session.behaviors : undefined,
      cwd: workingDir || undefined,
    });
  };

  const [isSavingDefaults, setIsSavingDefaults] = useState(false);

  const handleSaveDefaults = async () => {
    setIsSavingDefaults(true);
    usePrefsStore.setState({
      defaultBundle: selectedBundle,
      defaultBehaviors: selectedBehaviors,
      showThinking,
      defaultCwd: workingDir || null,
    });
    await saveToServer();
    setIsSavingDefaults(false);
  };

  // Validate custom bundle URI
  const handleValidateBundleUri = useCallback(async () => {
    if (!customBundleUri.trim()) return;

    setIsBundleValidating(true);
    setBundleError(null);
    setBundleValidationResult(null);

    const result = await validateBundleUri(customBundleUri.trim());

    setIsBundleValidating(false);
    if (result.valid) {
      setBundleValidationResult({ valid: true, bundleInfo: result.bundleInfo });
    } else {
      setBundleError(result.error || 'Invalid bundle URI');
    }
  }, [customBundleUri, validateBundleUri]);

  // Add custom bundle
  const handleAddCustomBundle = useCallback(async () => {
    if (!customBundleUri.trim()) return;

    setIsBundleAdding(true);
    setBundleError(null);

    const result = await addCustomBundle(customBundleUri.trim());

    setIsBundleAdding(false);

    if (result.success) {
      // Clear form, close it, and reload bundles
      setCustomBundleUri('');
      setBundleValidationResult(null);
      setShowAddBundleForm(false);

      // Reload bundles
      const response = await authFetch('/api/bundles');
      if (response.ok) {
        setBundles(await response.json());
      }
    } else {
      setBundleError(result.error || 'Failed to add bundle');
    }
  }, [customBundleUri, addCustomBundle]);

  // Remove custom bundle
  const handleRemoveCustomBundle = useCallback(async (name: string) => {
    const result = await removeCustomBundle(name);
    if (result.success) {
      // Reload bundles
      const response = await authFetch('/api/bundles');
      if (response.ok) {
        setBundles(await response.json());
      }
      // If we removed the selected bundle, switch to foundation
      if (selectedBundle === name) {
        setSelectedBundle('foundation');
      }
    }
  }, [removeCustomBundle, selectedBundle]);

  // Validate custom behavior URI
  const handleValidateBehaviorUri = useCallback(async () => {
    if (!customBehaviorUri.trim()) return;

    setIsBehaviorValidating(true);
    setBehaviorError(null);
    setBehaviorValidationResult(null);

    const result = await validateBundleUri(customBehaviorUri.trim());

    setIsBehaviorValidating(false);
    if (result.valid) {
      setBehaviorValidationResult({ valid: true, bundleInfo: result.bundleInfo });
    } else {
      setBehaviorError(result.error || 'Invalid behavior URI');
    }
  }, [customBehaviorUri, validateBundleUri]);

  // Add custom behavior
  const handleAddCustomBehavior = useCallback(async () => {
    if (!customBehaviorUri.trim()) return;

    setIsBehaviorAdding(true);
    setBehaviorError(null);

    const result = await addCustomBehavior(customBehaviorUri.trim());

    setIsBehaviorAdding(false);

    if (result.success) {
      // Clear form, close it, and reload behaviors
      setCustomBehaviorUri('');
      setBehaviorValidationResult(null);
      setShowAddBehaviorForm(false);

      // Reload behaviors
      const response = await authFetch('/api/behaviors');
      if (response.ok) {
        setBehaviors(await response.json());
      }
    } else {
      setBehaviorError(result.error || 'Failed to add behavior');
    }
  }, [customBehaviorUri, addCustomBehavior]);

  // Remove custom behavior
  const handleRemoveCustomBehavior = useCallback(async (name: string) => {
    const result = await removeCustomBehavior(name);
    if (result.success) {
      // Reload behaviors
      const response = await authFetch('/api/behaviors');
      if (response.ok) {
        setBehaviors(await response.json());
      }
      // Remove from selected if it was selected
      setSelectedBehaviors(prev => prev.filter(b => b !== name));
    }
  }, [removeCustomBehavior]);

  // Split bundles into standard and custom
  const standardBundles = bundles.filter(b => !b.is_custom);
  const customBundlesList = bundles.filter(b => b.is_custom);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-white">Configuration</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white"
        >
          &times;
        </button>
      </div>

      {/* Bundle selection */}
      <div className="mb-6">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Bundle</h3>
        <div className="space-y-2">
          {standardBundles.map((bundle) => (
            <label
              key={bundle.name}
              className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                selectedBundle === bundle.name
                  ? 'bg-amplifier-600/20 border border-amplifier-500'
                  : 'bg-gray-700/50 border border-transparent hover:bg-gray-700'
              }`}
            >
              <input
                type="radio"
                name="bundle"
                value={bundle.name}
                checked={selectedBundle === bundle.name}
                onChange={(e) => setSelectedBundle(e.target.value)}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-white">{bundle.name}</div>
                <div className="text-sm text-gray-400">{bundle.description}</div>
              </div>
            </label>
          ))}

          {/* Custom bundles */}
          {customBundlesList.map((bundle) => (
            <label
              key={bundle.name}
              className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                selectedBundle === bundle.name
                  ? 'bg-amplifier-600/20 border border-amplifier-500'
                  : 'bg-gray-700/50 border border-transparent hover:bg-gray-700'
              }`}
            >
              <input
                type="radio"
                name="bundle"
                value={bundle.name}
                checked={selectedBundle === bundle.name}
                onChange={(e) => setSelectedBundle(e.target.value)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white">{bundle.name}</span>
                  <span className="text-xs px-1.5 py-0.5 bg-purple-600/30 text-purple-300 rounded">
                    Custom
                  </span>
                </div>
                <div className="text-sm text-gray-400">{bundle.description}</div>
                {bundle.uri && (
                  <div className="text-xs text-gray-500 font-mono truncate mt-1">
                    {bundle.uri}
                  </div>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleRemoveCustomBundle(bundle.name);
                }}
                className="text-gray-400 hover:text-red-400 p-1"
                title="Remove bundle"
              >
                &times;
              </button>
            </label>
          ))}
        </div>
      </div>

      {/* Add Custom Bundle */}
      <div className="mb-6">
        {!showAddBundleForm ? (
          <button
            onClick={() => setShowAddBundleForm(true)}
            className="text-sm text-purple-400 hover:text-purple-300 transition-colors"
          >
            + Add custom bundle...
          </button>
        ) : (
          <div className="space-y-3 p-3 bg-gray-700/30 rounded-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-300">Add Custom Bundle</span>
              <button
                onClick={() => {
                  setShowAddBundleForm(false);
                  setCustomBundleUri('');
                  setBundleValidationResult(null);
                  setBundleError(null);
                }}
                className="text-gray-400 hover:text-white text-sm"
              >
                &times;
              </button>
            </div>

            <div>
              <input
                type="text"
                value={customBundleUri}
                onChange={(e) => {
                  setCustomBundleUri(e.target.value);
                  setBundleValidationResult(null);
                  setBundleError(null);
                }}
                placeholder="git+https://github.com/org/bundle or file://~/path"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amplifier-500"
                autoFocus
              />
            </div>

            {bundleValidationResult?.valid && (
              <div className="p-2 bg-green-900/30 border border-green-700 rounded text-sm">
                <div className="text-green-300 font-medium">Bundle validated</div>
                {bundleValidationResult.bundleInfo && (
                  <div className="text-green-400/80 text-xs mt-1">
                    {String(bundleValidationResult.bundleInfo.name)} v{String(bundleValidationResult.bundleInfo.version)}
                  </div>
                )}
              </div>
            )}

            {bundleError && (
              <div className="p-2 bg-red-900/30 border border-red-700 rounded text-sm text-red-300">
                {bundleError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleValidateBundleUri}
                disabled={!customBundleUri.trim() || isBundleValidating}
                className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-sm transition-colors"
              >
                {isBundleValidating ? 'Validating...' : 'Validate'}
              </button>
              <button
                onClick={handleAddCustomBundle}
                disabled={!customBundleUri.trim() || isBundleAdding}
                className="flex-1 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-sm transition-colors"
              >
                {isBundleAdding ? 'Adding...' : 'Add'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Behavior selection */}
      <div className="mb-6">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Behaviors</h3>
        <div className="space-y-2">
          {/* Standard behaviors */}
          {behaviors.filter(b => !b.is_custom).map((behavior) => (
            <label
              key={behavior.name}
              className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                selectedBehaviors.includes(behavior.name)
                  ? 'bg-amplifier-600/20 border border-amplifier-500'
                  : 'bg-gray-700/50 border border-transparent hover:bg-gray-700'
              }`}
            >
              <input
                type="checkbox"
                checked={selectedBehaviors.includes(behavior.name)}
                onChange={() => toggleBehavior(behavior.name)}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-white">{behavior.name}</div>
                <div className="text-sm text-gray-400">{behavior.description}</div>
              </div>
            </label>
          ))}

          {/* Custom behaviors */}
          {behaviors.filter(b => b.is_custom).map((behavior) => (
            <label
              key={behavior.name}
              className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                selectedBehaviors.includes(behavior.name)
                  ? 'bg-amplifier-600/20 border border-amplifier-500'
                  : 'bg-gray-700/50 border border-transparent hover:bg-gray-700'
              }`}
            >
              <input
                type="checkbox"
                checked={selectedBehaviors.includes(behavior.name)}
                onChange={() => toggleBehavior(behavior.name)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white">{behavior.name}</span>
                  <span className="text-xs px-1.5 py-0.5 bg-purple-600/30 text-purple-300 rounded">
                    Custom
                  </span>
                </div>
                <div className="text-sm text-gray-400">{behavior.description}</div>
                {behavior.uri && (
                  <div className="text-xs text-gray-500 font-mono truncate mt-1">
                    {behavior.uri}
                  </div>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleRemoveCustomBehavior(behavior.name);
                }}
                className="text-gray-400 hover:text-red-400 p-1"
                title="Remove behavior"
              >
                &times;
              </button>
            </label>
          ))}
        </div>
      </div>

      {/* Add Custom Behavior */}
      <div className="mb-6">
        {!showAddBehaviorForm ? (
          <button
            onClick={() => setShowAddBehaviorForm(true)}
            className="text-sm text-purple-400 hover:text-purple-300 transition-colors"
          >
            + Add custom behavior...
          </button>
        ) : (
          <div className="space-y-3 p-3 bg-gray-700/30 rounded-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-300">Add Custom Behavior</span>
              <button
                onClick={() => {
                  setShowAddBehaviorForm(false);
                  setCustomBehaviorUri('');
                  setBehaviorValidationResult(null);
                  setBehaviorError(null);
                }}
                className="text-gray-400 hover:text-white text-sm"
              >
                &times;
              </button>
            </div>

            <div>
              <input
                type="text"
                value={customBehaviorUri}
                onChange={(e) => {
                  setCustomBehaviorUri(e.target.value);
                  setBehaviorValidationResult(null);
                  setBehaviorError(null);
                }}
                placeholder="git+https://github.com/org/behavior or file://~/path"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amplifier-500"
                autoFocus
              />
            </div>

            {behaviorValidationResult?.valid && (
              <div className="p-2 bg-green-900/30 border border-green-700 rounded text-sm">
                <div className="text-green-300 font-medium">Behavior validated</div>
                {behaviorValidationResult.bundleInfo && (
                  <div className="text-green-400/80 text-xs mt-1">
                    {String(behaviorValidationResult.bundleInfo.name)} v{String(behaviorValidationResult.bundleInfo.version)}
                  </div>
                )}
              </div>
            )}

            {behaviorError && (
              <div className="p-2 bg-red-900/30 border border-red-700 rounded text-sm text-red-300">
                {behaviorError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleValidateBehaviorUri}
                disabled={!customBehaviorUri.trim() || isBehaviorValidating}
                className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-sm transition-colors"
              >
                {isBehaviorValidating ? 'Validating...' : 'Validate'}
              </button>
              <button
                onClick={handleAddCustomBehavior}
                disabled={!customBehaviorUri.trim() || isBehaviorAdding}
                className="flex-1 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-sm transition-colors"
              >
                {isBehaviorAdding ? 'Adding...' : 'Add'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Working directory */}
      <div className="mb-6">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Working Directory</h3>
        <input
          type="text"
          value={workingDir}
          onChange={(e) => setWorkingDir(e.target.value)}
          placeholder="/path/to/project (leave empty for default)"
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amplifier-500"
        />
        <div className="text-xs text-gray-500 mt-1">
          Base directory for file operations and @-mentions
        </div>
      </div>

      {/* Display options */}
      <div className="mb-6">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Display Options</h3>
        <label className="flex items-center gap-3 p-3 bg-gray-700/50 rounded-lg cursor-pointer">
          <input
            type="checkbox"
            checked={showThinking}
            onChange={(e) => setShowThinking(e.target.checked)}
          />
          <div>
            <div className="font-medium text-white">Show Thinking</div>
            <div className="text-sm text-gray-400">Display model reasoning blocks</div>
          </div>
        </label>
      </div>

      {/* Action buttons */}
      <div className="space-y-2">
        <button
          onClick={() => handleApply(false)}
          className="w-full py-3 bg-amplifier-600 hover:bg-amplifier-700 text-white rounded-lg transition-colors font-medium"
        >
          New Session
        </button>
        {session.sessionId && (
          <button
            onClick={() => handleApply(true)}
            className="w-full py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors text-sm"
          >
            Reconfigure (Keep History)
          </button>
        )}
        <button
          type="button"
          onClick={handleSaveDefaults}
          disabled={isSavingDefaults}
          className="w-full py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 text-white rounded-lg transition-colors text-sm"
        >
          {isSavingDefaults ? 'Saving...' : 'Save as Defaults'}
        </button>
      </div>

      {/* Current session info */}
      {session.sessionId && (
        <div className="mt-4 p-3 bg-gray-700/30 rounded-lg">
          <div className="text-xs text-gray-400 mb-1">Current Session</div>
          <div className="text-sm text-white font-mono">{session.sessionId}</div>
          <div className="text-sm text-gray-400">
            {session.turnCount} turn{session.turnCount !== 1 ? 's' : ''}
          </div>
        </div>
      )}
    </div>
  );
}
