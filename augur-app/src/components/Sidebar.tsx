import React from 'react';
import { AgentMode } from '../agent/types';
import { useAugurSession } from '../session/useAugurSession';
import { ChatView } from './ChatView';
import { NoDatasource } from './ChatPage';

export interface SidebarProps {
  q?: string;
  mode?: AgentMode;
  context?: string;
}

/** Docked Augur, available on every Grafana page via the extension sidebar (Grafana versions that have it). */
export default function Sidebar(props: SidebarProps) {
  const s = useAugurSession({ variant: 'sidebar', initialMode: props.mode });
  if (!s.claudeDs.length) {
    return <NoDatasource />;
  }
  return <ChatView s={s} variant="sidebar" autoStart={props.q ? { q: props.q, mode: props.mode, context: props.context } : undefined} />;
}
