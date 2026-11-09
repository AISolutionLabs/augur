import React, { useMemo } from 'react';
import { renderMarkdown } from '@grafana/data';

/** Renders model Markdown through Grafana's sanitising renderer. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`markdown-html ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
