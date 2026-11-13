import { useEffect, useSyncExternalStore } from 'react';
import { AgentMode } from '../agent/types';
import { describeLocation } from './pageContext';
import { getStore, MAX_PARALLEL_RUNS, RANGE_MS, expandSlashCommand } from './store';

export { MAX_PARALLEL_RUNS, RANGE_MS, expandSlashCommand };

export interface SessionOptions {
  variant: 'page' | 'sidebar';
  initialMode?: AgentMode;
  initialRange?: string;
}

/** React view onto the module-level Augur store (shared by the app page and the sidebar). */
export function useAugurSession(opts: SessionOptions) {
  const store = getStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  useEffect(() => {
    store.init({ initialMode: opts.initialMode, initialRange: opts.initialRange });
  }, [store, opts.initialMode, opts.initialRange]);

  const pageContext = () => (opts.variant === 'sidebar' ? describeLocation() : undefined);
  const run = state.session.run;

  return {
    ...state,
    interrupted: !state.running && !state.runningElsewhere && run?.status === 'interrupted' ? run : undefined,
    setDsUid: store.setDsUid,
    setModel: store.setModel,
    setSettings: store.setSettings,
    setMode: store.setMode,
    setRangeKey: store.setRangeKey,
    send: (text: string, extra?: { context?: string; mode?: AgentMode }) => store.send(text, { ...extra, pageContext: pageContext() }),
    resume: () => store.resume(pageContext()),
    dismissInterrupted: store.dismissInterrupted,
    stop: store.stop,
    reset: store.reset,
    open: store.open,
    remove: store.remove,
    clearHistory: store.clearHistory,
    rename: store.rename,
    togglePin: store.togglePin,
    resolveApproval: store.resolveApproval,
    noteApplied: store.noteApplied,
    saveInvestigation: store.saveInvestigation,
  };
}

export type AugurSession = ReturnType<typeof useAugurSession>;
