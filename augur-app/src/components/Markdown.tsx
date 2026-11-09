import React, { useMemo } from 'react';
import { renderMarkdown } from '@grafana/data';
import { locationService } from '@grafana/runtime';

/**
 * Renders model Markdown through Grafana's sanitising renderer. Relative links (Explore, dashboards,
 * alert rules) navigate inside the Grafana SPA instead of reloading the page.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href || !href.startsWith('/') || href.startsWith('//') || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') {
      return;
    }
    e.preventDefault();
    locationService.push(href);
  };
  return <div className={`markdown-html ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
