import React from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Badge, useStyles2 } from '@grafana/ui';
import { Finding, Hypothesis } from '../agent/types';

const STATUS_COLOR: Record<Hypothesis['status'], 'blue' | 'green' | 'red' | 'purple'> = {
  open: 'blue',
  supported: 'purple',
  confirmed: 'green',
  refuted: 'red',
};

export function InvestigationPanel({ findings, hypotheses }: { findings: Finding[]; hypotheses: Hypothesis[] }) {
  const s = useStyles2(getStyles);
  const sorted = [...hypotheses].sort((a, b) => Number(a.status === 'refuted') - Number(b.status === 'refuted') || b.confidence - a.confidence);
  return (
    <aside className={s.sidebar} data-testid="augur-investigation-panel">
      <h4>Hypotheses</h4>
      {sorted.length === 0 ? (
        <p className={s.muted}>Candidate causes appear here as Augur forms and tests them.</p>
      ) : (
        sorted.map((h) => (
          <div key={h.id} className={cx(s.card, h.status === 'refuted' && s.refuted)}>
            <div className={s.head}>
              <Badge color={STATUS_COLOR[h.status]} text={h.status} />
              <span>{Math.round(h.confidence * 100)}%{h.challenged ? ' · challenged' : ''}</span>
            </div>
            <div className={s.bar}>
              <div className={s.fill} style={{ width: `${Math.round(h.confidence * 100)}%` }} />
            </div>
            <b>{h.statement}</b>
            {h.evidence && <div className={s.muted}>{h.evidence}</div>}
          </div>
        ))
      )}
      <h4>Findings</h4>
      {findings.length === 0 ? (
        <p className={s.muted}>Confirmed facts are logged here as the investigation progresses.</p>
      ) : (
        findings.map((f, i) => (
          <div key={i} className={cx(s.card, s[`sev_${f.severity}`])}>
            <div className={s.head}>
              <Badge color={f.severity === 'critical' || f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'orange' : 'blue'} text={f.severity} />
              <span>{new Date(f.at).toISOString().slice(11, 19)}Z</span>
            </div>
            <b>{f.title}</b>
            <div>{f.detail}</div>
            {f.evidence && <code className={s.evidence}>{f.evidence}</code>}
          </div>
        ))
      )}
    </aside>
  );
}

const getStyles = (t: GrafanaTheme2) => ({
  sidebar: css({
    display: 'flex',
    flexDirection: 'column',
    gap: t.spacing(1),
    overflowY: 'auto',
    fontSize: t.typography.bodySmall.fontSize,
  }),
  card: css({
    borderLeft: `3px solid ${t.colors.info.border}`,
    background: t.colors.background.secondary,
    padding: t.spacing(1),
    display: 'flex',
    flexDirection: 'column',
    gap: t.spacing(0.5),
  }),
  refuted: css({ opacity: 0.6, textDecoration: 'line-through' }),
  head: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: t.colors.text.secondary }),
  bar: css({ height: 4, background: t.colors.background.canvas, borderRadius: 2 }),
  fill: css({ height: 4, background: t.colors.primary.main, borderRadius: 2 }),
  muted: css({ color: t.colors.text.secondary }),
  evidence: css({ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }),
  sev_info: css({ borderLeftColor: t.colors.info.border }),
  sev_low: css({ borderLeftColor: t.colors.info.border }),
  sev_medium: css({ borderLeftColor: t.colors.warning.border }),
  sev_high: css({ borderLeftColor: t.colors.error.border }),
  sev_critical: css({ borderLeftColor: t.colors.error.main }),
});
