import React, { useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, Spinner, useStyles2 } from '@grafana/ui';

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  label: string;
  input: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  output?: string;
  ms?: number;
}

export function ToolStep({ item }: { item: ToolItem }) {
  const s = useStyles2(getStyles);
  const [open, setOpen] = useState(false);
  return (
    <div className={s.step}>
      <button className={s.head} onClick={() => setOpen(!open)} aria-expanded={open} type="button">
        {item.status === 'running' ? <Spinner inline size="sm" /> : <Icon name={item.status === 'ok' ? 'check' : 'exclamation-triangle'} className={cx(item.status === 'error' && s.err)} />}
        <span className={s.label}>{item.label}</span>
        {item.ms !== undefined && <span className={s.ms}>{item.ms < 1000 ? `${item.ms}ms` : `${(item.ms / 1000).toFixed(1)}s`}</span>}
        <Icon name={open ? 'angle-up' : 'angle-down'} />
      </button>
      {open && (
        <div className={s.body}>
          <div className={s.caption}>Input · {item.name}</div>
          <pre className={s.pre}>{JSON.stringify(item.input, null, 2)}</pre>
          {item.output !== undefined && (
            <>
              <div className={s.caption}>Result sent to Claude</div>
              <pre className={s.pre}>{item.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const getStyles = (t: GrafanaTheme2) => ({
  step: css({ borderLeft: `2px solid ${t.colors.border.medium}`, marginLeft: t.spacing(1), paddingLeft: t.spacing(1) }),
  head: css({
    all: 'unset',
    cursor: 'pointer',
    display: 'flex',
    gap: t.spacing(1),
    alignItems: 'center',
    width: '100%',
    color: t.colors.text.secondary,
    fontSize: t.typography.bodySmall.fontSize,
    padding: `${t.spacing(0.25)} 0`,
    '&:hover': { color: t.colors.text.primary },
  }),
  label: css({ flex: 1, fontFamily: t.typography.fontFamilyMonospace, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  ms: css({ color: t.colors.text.disabled }),
  err: css({ color: t.colors.error.text }),
  body: css({ padding: t.spacing(1, 0) }),
  caption: css({ fontSize: t.typography.bodySmall.fontSize, color: t.colors.text.secondary, margin: t.spacing(0.5, 0) }),
  pre: css({ maxHeight: 320, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }),
});
