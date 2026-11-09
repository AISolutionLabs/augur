// Describes the Grafana page the user is looking at, so the sidebar can answer "what's wrong here?".

export function describeLocation(loc: { pathname: string; search: string } = window.location): string {
  const params = new URLSearchParams(loc.search);
  const range = params.get('from') ? ` time range ${params.get('from')} → ${params.get('to') ?? 'now'}` : '';
  const vars = [...params.entries()].filter(([k]) => k.startsWith('var-')).map(([k, v]) => `${k.slice(4)}=${v}`);
  let m: RegExpMatchArray | null;
  if ((m = loc.pathname.match(/\/d\/([^/]+)/))) {
    const panel = params.get('viewPanel') ?? params.get('editPanel');
    return `Dashboard uid ${m[1]}${panel ? `, panel ${panel}` : ''}${range}${vars.length ? `, variables ${vars.join(', ')}` : ''} (use get_dashboard).`;
  }
  if (loc.pathname.startsWith('/explore')) {
    try {
      const panes = JSON.parse(params.get('panes') ?? '{}');
      const descr = Object.values<any>(panes)
        .map((p) => `datasource ${p.datasource}: ${(p.queries ?? []).map((q: any) => q.expr ?? q.query ?? '').filter(Boolean).join(' ; ')} (range ${p.range?.from} → ${p.range?.to})`)
        .join(' | ');
      return `Explore with ${descr || 'no queries'}.`;
    } catch {
      return 'Explore.';
    }
  }
  if ((m = loc.pathname.match(/\/alerting\/grafana\/([^/]+)\/view/))) {
    return `Alert rule uid ${m[1]} (use list_alerts / alert_state_history).`;
  }
  if (loc.pathname.startsWith('/alerting')) {
    return `Alerting page ${loc.pathname}.`;
  }
  return '';
}
