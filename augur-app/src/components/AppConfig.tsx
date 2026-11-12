import React, { useState } from 'react';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps } from '@grafana/data';
import { config } from '@grafana/runtime';
import {
  Alert,
  Button,
  Field,
  FieldSet,
  Input,
  InlineSwitch,
  RadioButtonGroup,
  Stack,
  Tab,
  TabContent,
  TabsBar,
  TagsInput,
  TextArea,
  useStyles2,
} from '@grafana/ui';
import { AugurSettings, newId, Rule, RuleScope, saveSettings, Skill, slugify } from '../settings';
import { grafanaHttp, listDataSources } from '../api';
import { scanInfrastructure } from '../agent/memoryScan';
import { parseSkillMarkdown } from '../skillFormat';

type Props = PluginConfigPageProps<AppPluginMeta<AugurSettings>>;

const SCOPES: Array<{ label: string; value: RuleScope }> = [
  { label: 'Always', value: 'all' },
  { label: 'Chat', value: 'chat' },
  { label: 'Investigations', value: 'investigate' },
  { label: 'Dashboards', value: 'dashboards' },
];

export default function AppConfig({ plugin }: Props) {
  const s = useStyles2(getStyles);
  const [settings, setSettings] = useState<AugurSettings>(plugin.meta.jsonData ?? {});
  const [tab, setTab] = useState<'rules' | 'skills' | 'memory' | 'general'>('rules');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | undefined>();
  const [editing, setEditing] = useState<number | undefined>();
  const [scan, setScan] = useState<string | undefined>();

  const patch = (p: Partial<AugurSettings>) => setSettings((x) => ({ ...x, ...p }));
  const rules = settings.rules ?? [];
  const skills = settings.skills ?? [];

  const save = async (next = settings) => {
    setSaving(true);
    setMsg(undefined);
    try {
      await saveSettings(grafanaHttp, next);
      setMsg({ ok: true, text: 'Saved. New conversations use the updated settings.' });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.data?.message ?? e?.message ?? 'Save failed (org admin required)' });
    } finally {
      setSaving(false);
    }
  };

  const runScan = async () => {
    setScan('Starting…');
    try {
      const memory = await scanInfrastructure(grafanaHttp, listDataSources(), { user: config.bootData?.user?.login, onProgress: setScan });
      const next = { ...settings, memory };
      setSettings(next);
      await save(next);
      setScan(undefined);
    } catch (e: any) {
      setScan(`Scan failed: ${e?.message ?? e}`);
    }
  };

  const setRule = (i: number, r: Partial<Rule>) => patch({ rules: rules.map((x, j) => (j === i ? { ...x, ...r } : x)) });
  const setSkill = (i: number, k: Partial<Skill>) => patch({ skills: skills.map((x, j) => (j === i ? { ...x, ...k } : x)) });

  return (
    <div className={s.wrap}>
      <p className={s.muted}>
        Organisation-wide settings for Augur, stored in this app&apos;s settings (provisionable via <code>apps.yaml</code> <code>jsonData</code>). The model
        endpoint and credentials are configured on the <b>Claude (Augur)</b> datasource.
      </p>
      <TabsBar>
        <Tab label={`Rules (${rules.length})`} active={tab === 'rules'} onChangeTab={() => setTab('rules')} />
        <Tab label={`Skills (${skills.length})`} active={tab === 'skills'} onChangeTab={() => setTab('skills')} />
        <Tab label="Infrastructure memory" active={tab === 'memory'} onChangeTab={() => setTab('memory')} />
        <Tab label="General" active={tab === 'general'} onChangeTab={() => setTab('general')} />
      </TabsBar>
      <TabContent className={s.content}>
        {tab === 'rules' && (
          <FieldSet label="Rules">
            <p className={s.muted}>Instructions Augur always follows: naming conventions, which datasource is prod, escalation policy, things never to do.</p>
            {rules.map((r, i) => (
              <div key={r.id} className={s.row}>
                <TextArea rows={2} value={r.text} onChange={(e) => setRule(i, { text: e.currentTarget.value })} placeholder="e.g. Production metrics are in the 'Mimir prod' datasource; cluster label is k8s_cluster." />
                <Stack gap={1} alignItems="center">
                  <RadioButtonGroup size="sm" options={SCOPES} value={r.scope} onChange={(v) => setRule(i, { scope: v })} />
                  <InlineSwitch label="Enabled" showLabel value={r.enabled} onChange={(e) => setRule(i, { enabled: e.currentTarget.checked })} />
                  <Button size="sm" variant="destructive" fill="text" icon="trash-alt" onClick={() => patch({ rules: rules.filter((_, j) => j !== i) })} aria-label="Delete rule" />
                </Stack>
              </div>
            ))}
            <Button variant="secondary" icon="plus" onClick={() => patch({ rules: [...rules, { id: newId(), text: '', scope: 'all', enabled: true }] })}>
              Add rule
            </Button>
          </FieldSet>
        )}

        {tab === 'skills' && (
          <FieldSet label="Skills">
            <p className={s.muted}>Runbooks and playbooks Augur discovers while working (search_skills / read_skill) and users can run as /commands. Markdown with optional front matter (name, title, description, tags).</p>
            {skills.map((k, i) => (
              <div key={`${k.name}-${i}`} className={s.row}>
                <Stack justifyContent="space-between" alignItems="center">
                  <div>
                    <b>/{k.name}</b> — {k.title} <span className={s.muted}>{k.description}</span>
                  </div>
                  <Stack gap={1} alignItems="center">
                    <InlineSwitch label="Enabled" showLabel value={k.enabled} onChange={(e) => setSkill(i, { enabled: e.currentTarget.checked })} />
                    <Button size="sm" variant="secondary" onClick={() => setEditing(editing === i ? undefined : i)}>
                      {editing === i ? 'Close' : 'Edit'}
                    </Button>
                    <Button size="sm" variant="destructive" fill="text" icon="trash-alt" onClick={() => patch({ skills: skills.filter((_, j) => j !== i) })} aria-label="Delete skill" />
                  </Stack>
                </Stack>
                {editing === i && (
                  <div className={s.editor}>
                    <Field label="Command name">
                      <Input value={k.name} onChange={(e) => setSkill(i, { name: slugify(e.currentTarget.value) })} />
                    </Field>
                    <Field label="Title">
                      <Input value={k.title} onChange={(e) => setSkill(i, { title: e.currentTarget.value })} />
                    </Field>
                    <Field label="When to use (description)">
                      <Input value={k.description} onChange={(e) => setSkill(i, { description: e.currentTarget.value })} />
                    </Field>
                    <Field label="Tags">
                      <TagsInput tags={k.tags ?? []} onChange={(tags) => setSkill(i, { tags })} />
                    </Field>
                    <Field label="Instructions (Markdown)">
                      <TextArea rows={14} value={k.body} onChange={(e) => setSkill(i, { body: e.currentTarget.value })} />
                    </Field>
                  </div>
                )}
              </div>
            ))}
            <Stack gap={1}>
              <Button
                variant="secondary"
                icon="plus"
                onClick={() => {
                  patch({ skills: [...skills, { name: `skill-${skills.length + 1}`, title: 'New skill', description: '', body: '', enabled: true, tags: [] }] });
                  setEditing(skills.length);
                }}
              >
                Add skill
              </Button>
              <Button
                variant="secondary"
                icon="upload"
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.md,.markdown,.txt';
                  input.multiple = true;
                  input.onchange = async () => {
                    const files = Array.from(input.files ?? []);
                    const parsed = await Promise.all(files.map(async (f) => parseSkillMarkdown(await f.text(), f.name)));
                    patch({ skills: [...skills.filter((k) => !parsed.some((p) => p.name === k.name)), ...parsed] });
                  };
                  input.click();
                }}
              >
                Import Markdown
              </Button>
            </Stack>
          </FieldSet>
        )}

        {tab === 'memory' && (
          <FieldSet label="Infrastructure memory">
            <p className={s.muted}>Scans the Prometheus/Mimir, Loki, Tempo and Pyroscope datasources you can see for services, namespaces and the Tempo service graph. No model calls. Augur uses it to resolve service names and follow dependencies.</p>
            {settings.memory ? (
              <div className={s.row}>
                <div className={s.muted}>
                  Last scan {new Date(settings.memory.scannedAt).toLocaleString()}
                  {settings.memory.scannedBy ? ` by ${settings.memory.scannedBy}` : ''} · {settings.memory.services.length} services · {settings.memory.edges.length} dependencies
                </div>
                <pre className={s.pre}>{settings.memory.summary}</pre>
              </div>
            ) : (
              <p className={s.muted}>No scan yet.</p>
            )}
            <Stack gap={1} alignItems="center">
              <Button icon="sync" onClick={runScan} disabled={!!scan && !scan.startsWith('Scan failed')}>
                {settings.memory ? 'Rescan' : 'Scan now'}
              </Button>
              {settings.memory && (
                <Button variant="secondary" fill="text" onClick={() => patch({ memory: undefined })}>
                  Clear
                </Button>
              )}
              {scan && <span className={s.muted}>{scan}</span>}
            </Stack>
          </FieldSet>
        )}

        {tab === 'general' && (
          <FieldSet label="General">
            <Field label="Folder for saved investigations" description="Folder UID; empty = Dashboards root. Folder permissions control who can read saved investigations.">
              <Input width={40} value={settings.investigationFolderUid ?? ''} onChange={(e) => patch({ investigationFolderUid: e.currentTarget.value || undefined })} />
            </Field>
            <Field label="Sub-agents in investigations" description="Lets investigations fan out to parallel specialist agents (more coverage, more tokens).">
              <InlineSwitch value={settings.enableSubAgents !== false} onChange={(e) => patch({ enableSubAgents: e.currentTarget.checked })} />
            </Field>
            <Field label="Token limit per run" description="Input + output + cache writes (cache reads count 10%), including sub-agents. When reached, Augur stops querying and answers from what it has. Default 1,500,000.">
              <Input
                type="number"
                width={20}
                placeholder="1500000"
                value={settings.maxTokensPerRun ?? ''}
                onChange={(e) => patch({ maxTokensPerRun: Number(e.currentTarget.value) || undefined })}
              />
            </Field>
            <Field label="Tool budget per turn (chat / investigation)">
              <Stack gap={1}>
                <Input type="number" width={12} placeholder="15" value={settings.stepBudget?.chat ?? ''} onChange={(e) => patch({ stepBudget: { ...settings.stepBudget, chat: Number(e.currentTarget.value) || undefined } })} />
                <Input type="number" width={12} placeholder="45" value={settings.stepBudget?.investigate ?? ''} onChange={(e) => patch({ stepBudget: { ...settings.stepBudget, investigate: Number(e.currentTarget.value) || undefined } })} />
              </Stack>
            </Field>
            <Field
              label="Keep conversations for (days)"
              description="Conversations are stored in each user's browser. Those not updated for this many days are deleted the next time Augur opens (pinned ones are kept). Empty keeps the 60 most recent."
            >
              <Input
                type="number"
                width={20}
                aria-label="Keep conversations for (days)"
                placeholder="no limit"
                value={settings.historyRetentionDays ?? ''}
                onChange={(e) => patch({ historyRetentionDays: Number(e.currentTarget.value) || undefined })}
              />
            </Field>
          </FieldSet>
        )}
      </TabContent>
      {msg && (
        <Alert severity={msg.ok ? 'success' : 'error'} title={msg.ok ? 'Saved' : 'Error'}>
          {msg.text}
        </Alert>
      )}
      <Button icon="save" onClick={() => save()} disabled={saving}>
        {saving ? 'Saving…' : 'Save settings'}
      </Button>
    </div>
  );
}

const getStyles = (t: GrafanaTheme2) => ({
  wrap: css({ display: 'flex', flexDirection: 'column', gap: t.spacing(2), maxWidth: 1000 }),
  content: css({ paddingTop: t.spacing(2) }),
  row: css({ border: `1px solid ${t.colors.border.weak}`, borderRadius: t.shape.radius.default, padding: t.spacing(1.5), marginBottom: t.spacing(1), display: 'flex', flexDirection: 'column', gap: t.spacing(1) }),
  editor: css({ paddingTop: t.spacing(1) }),
  muted: css({ color: t.colors.text.secondary }),
  pre: css({ fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }),
});
