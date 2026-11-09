import React, { ChangeEvent } from 'react';
import { Alert, Button, Field, FieldSet, InlineSwitch, Input, RadioButtonGroup, SecretInput, Switch, TagsInput, Stack } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { ApiKeyHeader, AuthMethod, ClaudeDataSourceOptions, ClaudeSecureJsonData, McpAuth, McpServerConfig, OAuthTokenType } from '../types';

interface Props extends DataSourcePluginOptionsEditorProps<ClaudeDataSourceOptions, ClaudeSecureJsonData> {}

const authOptions: Array<{ label: string; value: AuthMethod; description: string }> = [
  { label: 'API key', value: 'apiKey', description: 'One key stored encrypted in Grafana (LiteLLM virtual key or Anthropic key)' },
  { label: 'Forward OAuth token', value: 'oauth', description: "Send each signed-in user's own OAuth/OIDC token" },
  { label: 'None', value: 'none', description: 'No auth header (network or mTLS auth)' },
];

const headerOptions: Array<{ label: string; value: ApiKeyHeader }> = [
  { label: 'Authorization: Bearer', value: 'authorization' },
  { label: 'x-api-key', value: 'x-api-key' },
];

const tokenOptions: Array<{ label: string; value: OAuthTokenType }> = [
  { label: 'Access token', value: 'access' },
  { label: 'ID token', value: 'id' },
];

export function ConfigEditor(props: Props) {
  const { onOptionsChange, options } = props;
  const { jsonData, secureJsonFields, secureJsonData } = options;
  const authMethod = jsonData.authMethod ?? 'apiKey';

  const setJson = (patch: Partial<ClaudeDataSourceOptions>) =>
    onOptionsChange({ ...options, jsonData: { ...jsonData, ...patch } });

  const setAuthMethod = (m: AuthMethod) =>
    // oauthPassThru is the flag Grafana itself reads to decide whether to forward the user's token.
    setJson({ authMethod: m, oauthPassThru: m === 'oauth' });

  const numberOrUndefined = (v: string) => (v.trim() === '' ? undefined : Number(v));

  return (
    <Stack direction="column" gap={2}>
      <FieldSet label="Endpoint">
        <Field
          label="URL"
          description="Base URL of a Claude Messages API endpoint, e.g. https://litellm.example.internal or https://api.anthropic.com"
          required
        >
          <Input
            id="claude-url"
            width={60}
            value={options.url}
            placeholder="https://litellm.example.internal"
            onChange={(e: ChangeEvent<HTMLInputElement>) => onOptionsChange({ ...options, url: e.target.value })}
          />
        </Field>
        <Field label="Messages path" description="Default /v1/messages (Anthropic and LiteLLM)">
          <Input
            width={30}
            value={jsonData.messagesPath ?? ''}
            placeholder="/v1/messages"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ messagesPath: e.target.value || undefined })}
          />
        </Field>
        <Field label="Models path" description="Used by Save & test. Default /v1/models">
          <Input
            width={30}
            value={jsonData.modelsPath ?? ''}
            placeholder="/v1/models"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ modelsPath: e.target.value || undefined })}
          />
        </Field>
      </FieldSet>

      <FieldSet label="Authentication">
        <Field label="Method">
          <RadioButtonGroup options={authOptions} value={authMethod} onChange={setAuthMethod} />
        </Field>

        {authMethod === 'apiKey' && (
          <>
            <Field label="API key" required>
              <SecretInput
                id="claude-api-key"
                width={60}
                isConfigured={!!secureJsonFields?.apiKey}
                value={secureJsonData?.apiKey ?? ''}
                placeholder="sk-..."
                onReset={() =>
                  onOptionsChange({
                    ...options,
                    secureJsonFields: { ...secureJsonFields, apiKey: false },
                    secureJsonData: { ...secureJsonData, apiKey: '' },
                  })
                }
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  onOptionsChange({ ...options, secureJsonData: { ...secureJsonData, apiKey: e.target.value } })
                }
              />
            </Field>
            <Field label="Send key as">
              <RadioButtonGroup
                options={headerOptions}
                value={jsonData.apiKeyHeader ?? 'authorization'}
                onChange={(v) => setJson({ apiKeyHeader: v })}
              />
            </Field>
          </>
        )}

        {authMethod === 'oauth' && (
          <>
            <Alert severity="info" title="Per-user tokens">
              Grafana forwards the signed-in user&apos;s OAuth token for this datasource only. Users must log in to Grafana
              through OAuth/OIDC (e.g. Entra ID), and the token&apos;s audience must be accepted by your endpoint. For an
              access token, add your gateway&apos;s scope (e.g. api://&lt;litellm-app-id&gt;/.default) to Grafana&apos;s OAuth
              scopes; the ID token&apos;s audience is Grafana&apos;s own client ID.
            </Alert>
            <Field label="Token to forward">
              <RadioButtonGroup
                options={tokenOptions}
                value={jsonData.oauthTokenType ?? 'access'}
                onChange={(v) => setJson({ oauthTokenType: v })}
              />
            </Field>
            <Field label="Forward OAuth Identity" description="Must stay on for OAuth mode">
              <Switch value={!!jsonData.oauthPassThru} onChange={(e) => setJson({ oauthPassThru: e.currentTarget.checked })} />
            </Field>
          </>
        )}
      </FieldSet>

      <McpSection {...props} />

      <FieldSet label="Model">
        <Field label="Default model" description="Model name as your endpoint knows it (LiteLLM model alias or Anthropic model ID)">
          <Input
            width={40}
            value={jsonData.defaultModel ?? ''}
            placeholder="claude-sonnet-5-5"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ defaultModel: e.target.value || undefined })}
          />
        </Field>
        <Field label="Other allowed models" description="Users can pick these in the chat; anything else is rejected server-side">
          <TagsInput tags={jsonData.allowedModels ?? []} onChange={(tags) => setJson({ allowedModels: tags })} width={60} />
        </Field>
        <Field label="Max output tokens" description="Upper bound per response (default 8192)">
          <Input
            type="number"
            width={20}
            value={jsonData.maxTokens ?? ''}
            placeholder="8192"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ maxTokens: numberOrUndefined(e.target.value) })}
          />
        </Field>
        <Field label="Timeout (seconds)" description="Per model call (default 300)">
          <Input
            type="number"
            width={20}
            value={jsonData.timeoutSeconds ?? ''}
            placeholder="300"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ timeoutSeconds: numberOrUndefined(e.target.value) })}
          />
        </Field>
        <Field label="anthropic-version header" description="Default 2023-06-01">
          <Input
            width={20}
            value={jsonData.anthropicVersion ?? ''}
            placeholder="2023-06-01"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ anthropicVersion: e.target.value || undefined })}
          />
        </Field>
      </FieldSet>
    </Stack>
  );
}

const mcpAuthOptions: Array<{ label: string; value: McpAuth }> = [
  { label: 'None', value: 'none' },
  { label: 'Bearer token', value: 'bearer' },
  { label: 'Custom header', value: 'header' },
  { label: "User's OAuth token", value: 'oauth' },
];

function McpSection({ options, onOptionsChange }: Props) {
  const servers = options.jsonData.mcpServers ?? [];
  const setServers = (next: McpServerConfig[]) => onOptionsChange({ ...options, jsonData: { ...options.jsonData, mcpServers: next } });
  const set = (i: number, patch: Partial<McpServerConfig>) => setServers(servers.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const secretKey = (name: string) => `mcpToken_${name}`;
  return (
    <FieldSet label="MCP servers">
      <p>
        Remote MCP servers (streamable HTTP) whose tools Augur can use, e.g. GitHub, Azure DevOps, Kubernetes or a runbook wiki. Calls are proxied
        through this backend, so internal endpoints work and tokens stay server-side. Tools not marked read-only ask the user before running.
      </p>
      {servers.map((srv, i) => (
        <div key={i} style={{ border: '1px solid rgba(128,128,128,0.3)', borderRadius: 4, padding: 12, marginBottom: 12 }}>
          <Stack direction="row" gap={2} wrap="wrap">
            <Field label="Name" description="Used in tool names">
              <Input width={20} value={srv.name} onChange={(e: ChangeEvent<HTMLInputElement>) => set(i, { name: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '') })} />
            </Field>
            <Field label="URL" description="MCP endpoint, e.g. https://mcp.example.internal/mcp">
              <Input width={50} value={srv.url} onChange={(e: ChangeEvent<HTMLInputElement>) => set(i, { url: e.target.value })} />
            </Field>
          </Stack>
          <Field label="Auth">
            <RadioButtonGroup options={mcpAuthOptions} value={srv.auth ?? 'none'} onChange={(v) => set(i, { auth: v })} />
          </Field>
          {srv.auth === 'header' && (
            <Field label="Header name">
              <Input width={30} value={srv.headerName ?? ''} onChange={(e: ChangeEvent<HTMLInputElement>) => set(i, { headerName: e.target.value })} />
            </Field>
          )}
          {(srv.auth === 'bearer' || srv.auth === 'header') && srv.name && (
            <Field label="Token">
              <SecretInput
                width={50}
                isConfigured={!!options.secureJsonFields?.[secretKey(srv.name)]}
                value={options.secureJsonData?.[secretKey(srv.name)] ?? ''}
                onReset={() =>
                  onOptionsChange({
                    ...options,
                    secureJsonFields: { ...options.secureJsonFields, [secretKey(srv.name)]: false },
                    secureJsonData: { ...options.secureJsonData, [secretKey(srv.name)]: '' },
                  })
                }
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  onOptionsChange({ ...options, secureJsonData: { ...options.secureJsonData, [secretKey(srv.name)]: e.target.value } })
                }
              />
            </Field>
          )}
          {srv.auth === 'oauth' && !options.jsonData.oauthPassThru && (
            <Alert severity="warning" title="Forward OAuth Identity is off">
              Switch the main authentication to &quot;Forward OAuth token&quot; so Grafana passes user tokens to this datasource.
            </Alert>
          )}
          <Field label="Allowed tools" description="Optional glob patterns, e.g. get_*, search_*. Empty = all tools.">
            <TagsInput tags={srv.allowedTools ?? []} onChange={(tags) => set(i, { allowedTools: tags })} width={60} />
          </Field>
          <Stack direction="row" gap={2} alignItems="center">
            <InlineSwitch
              label="Ask before running tools not marked read-only"
              showLabel
              value={srv.requireApproval !== false}
              onChange={(e) => set(i, { requireApproval: e.currentTarget.checked })}
            />
            <Button variant="destructive" fill="text" icon="trash-alt" onClick={() => setServers(servers.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </Stack>
        </div>
      ))}
      <Button variant="secondary" icon="plus" onClick={() => setServers([...servers, { name: '', url: '', auth: 'none', requireApproval: true }])}>
        Add MCP server
      </Button>
    </FieldSet>
  );
}
