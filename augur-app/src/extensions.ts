import { PluginExtensionPanelContext } from '@grafana/data';
import { PLUGIN_BASE_URL } from './constants';

const MAX_CONTEXT = 1800;

function rawTime(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  const anyV = v as any;
  return anyV?.toISOString?.() ?? String(v);
}

/** Builds the Claude app URL that opens with a pre-filled question and context. */
export function claudeUrl(opts: { q: string; mode: 'chat' | 'investigate'; context?: string }): string {
  const p = new URLSearchParams({ mode: opts.mode, q: opts.q });
  if (opts.context) {
    p.set('context', opts.context.slice(0, MAX_CONTEXT));
  }
  return `${PLUGIN_BASE_URL}?${p.toString()}`;
}

export function panelContextText(ctx?: PluginExtensionPanelContext): string {
  if (!ctx) {
    return '';
  }
  const targets = (ctx.targets ?? [])
    .map((t: any) => `  ${t.refId}: ${t.expr ?? t.query ?? t.rawSql ?? ''}${t.datasource?.uid ? ` (datasource ${t.datasource.uid})` : ''}`)
    .join('\n');
  return [
    `Dashboard: "${ctx.dashboard?.title}" (uid ${ctx.dashboard?.uid})`,
    `Panel: "${ctx.title}" (id ${ctx.id}, type ${ctx.pluginId})`,
    `Time range: ${rawTime(ctx.timeRange?.from)} → ${rawTime(ctx.timeRange?.to)}`,
    targets ? `Queries:\n${targets}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Best-effort summary of the alert rule/instance passed by the alerting extension points. */
export function alertContextText(ctx: any): string {
  if (!ctx) {
    return '';
  }
  const rule = ctx.rule ?? ctx.alertingRule ?? ctx;
  const parts = [
    rule?.name || rule?.title ? `Alert rule: "${rule.name ?? rule.title}"${rule.uid ? ` (uid ${rule.uid})` : ''}` : '',
    rule?.labels ? `Labels: ${JSON.stringify(rule.labels)}` : '',
    rule?.annotations ? `Annotations: ${JSON.stringify(rule.annotations).slice(0, 500)}` : '',
    ctx.instance?.labels ? `Instance labels: ${JSON.stringify(ctx.instance.labels)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : JSON.stringify(ctx).slice(0, 800);
}

/** Summary of the Explore pane the user invoked Augur from. */
export function exploreContextText(ctx: any): string {
  if (!ctx) {
    return '';
  }
  const targets = (ctx.targets ?? [])
    .map((t: any) => `  ${t.refId}: ${t.expr ?? t.query ?? ''}${t.datasource?.uid ? ` (datasource ${t.datasource.uid})` : ''}`)
    .join('\n');
  const range = ctx.timeRange ? `Time range: ${String(ctx.timeRange.from?.toISOString?.() ?? ctx.timeRange.raw?.from ?? '')} → ${String(ctx.timeRange.to?.toISOString?.() ?? ctx.timeRange.raw?.to ?? '')}` : '';
  return ['Explore', range, targets ? `Queries:\n${targets}` : ''].filter(Boolean).join('\n');
}
