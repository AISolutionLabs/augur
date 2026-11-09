import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { Button, EmptyState } from '@grafana/ui';
import { AgentMode } from '../agent/types';
import { useAugurSession } from '../session/useAugurSession';
import { ChatView } from './ChatView';

export function NoDatasource() {
  return (
    <EmptyState
      variant="call-to-action"
      message="Connect Augur to Claude"
      button={
        <Button icon="plus" onClick={() => (window.location.href = '/connections/datasources/new')}>
          Add Claude datasource
        </Button>
      }
    >
      Add a <b>Claude (Augur)</b> datasource (Connections → Data sources) pointing at your LiteLLM proxy or the Anthropic API, using an API key or by forwarding each user&apos;s OAuth token.
    </EmptyState>
  );
}

export function ChatPage() {
  const [params, setParams] = useSearchParams();
  // Read entry-point parameters once, then clear them so a reload doesn't re-run the prompt.
  const autoStart = useMemo(() => {
    const q = params.get('q');
    if (!q) {
      return undefined;
    }
    const value = { q, mode: (params.get('mode') as AgentMode) || undefined, context: params.get('context') ?? undefined };
    const next = new URLSearchParams(params);
    ['q', 'mode', 'context'].forEach((k) => next.delete(k));
    setTimeout(() => setParams(next, { replace: true }), 0);
    return value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const s = useAugurSession({ variant: 'page', initialMode: (params.get('mode') as AgentMode) || undefined, initialRange: params.get('range') || undefined });

  return <PluginPage>{s.claudeDs.length ? <ChatView s={s} variant="page" autoStart={autoStart} /> : <NoDatasource />}</PluginPage>;
}
