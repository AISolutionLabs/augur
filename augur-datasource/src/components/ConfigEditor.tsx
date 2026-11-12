import React, { ChangeEvent } from 'react';
import { Alert, Button, Field, FieldSet, InlineSwitch, Input, RadioButtonGroup, SecretInput, SecretTextArea, Switch, TagsInput, Stack, Text } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { ApiFormat, ApiKeyHeader, AuthMethod, ClaudeDataSourceOptions, ClaudeSecureJsonData, McpAuth, McpServerConfig, OAuthTokenType } from '../types';

interface Props extends DataSourcePluginOptionsEditorProps<ClaudeDataSourceOptions, ClaudeSecureJsonData> {}

const authOptions: Array<{ label: string; value: AuthMethod; description: string }> = [
  { label: 'API key', value: 'apiKey', description: 'One key stored encrypted in Grafana (LiteLLM virtual key or Anthropic key)' },
  { label: 'Forward OAuth token', value: 'oauth', description: "Send each signed-in user's own OAuth/OIDC token" },
  { label: 'None', value: 'none', description: 'No auth header (network or mTLS auth)' },
];

const headerOptions: Array<{ label: string; value: ApiKeyHeader }> = [
  { label: 'Authorization: Bearer', value: 'authorization' },
  { label: 'x-api-key', value: 'x-api-key' },
  { label: 'api-key (Azure)', value: 'api-key' },
];

const formatOptions: Array<{ label: string; value: ApiFormat; description: string }> = [
  { label: 'Claude Messages', value: 'anthropic', description: 'Anthropic API, LiteLLM /v1/messages, Bedrock gateways (recommended)' },
  { label: 'OpenAI-compatible', value: 'openai', description: 'Chat Completions: Azure OpenAI, vLLM, Ollama, LiteLLM /v1/chat/completions' },
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
        <Field label="API format" description="Augur is designed and tested with Claude; other models work through the OpenAI-compatible format but investigation quality depends heavily on the model's tool use.">
          <RadioButtonGroup options={formatOptions} value={jsonData.apiFormat ?? 'anthropic'} onChange={(v) => setJson({ apiFormat: v })} />
        </Field>
        {jsonData.apiFormat === 'openai' && (
          <Field label="Max tokens parameter" description="Newer OpenAI models require max_completion_tokens">
            <RadioButtonGroup
              options={[
                { label: 'max_tokens', value: 'max_tokens' },
                { label: 'max_completion_tokens', value: 'max_completion_tokens' },
              ]}
              value={jsonData.maxTokensField ?? 'max_tokens'}
              onChange={(v) => setJson({ maxTokensField: v as 'max_tokens' | 'max_completion_tokens' })}
            />
          </Field>
        )}
        <Field label="Messages path" description={jsonData.apiFormat === 'openai' ? 'Default /v1/chat/completions (for Azure include the deployment path and ?api-version=…)' : 'Default /v1/messages (Anthropic and LiteLLM)'}>
          <Input
            width={30}
            value={jsonData.messagesPath ?? ''}
            placeholder={jsonData.apiFormat === 'openai' ? '/v1/chat/completions' : '/v1/messages'}
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

      <TlsSection {...props} />

      <FieldSet label="Model">
        <Field
          label="Discover models from the endpoint"
          description={`List the models ${jsonData.modelsPath ?? '/v1/models'} returns for the caller's credentials (a LiteLLM key or the user's own OAuth token), so users only see models they can use. Off: only the models below.`}
        >
          <Switch value={jsonData.modelDiscovery !== 'off'} onChange={(e) => setJson({ modelDiscovery: e.currentTarget.checked ? undefined : 'off' })} />
        </Field>
        <Field label="Default model" description="Model name as your endpoint knows it (LiteLLM model alias or Anthropic model ID)">
          <Input
            width={40}
            value={jsonData.defaultModel ?? ''}
            placeholder="claude-sonnet-5-5"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ defaultModel: e.target.value || undefined })}
          />
        </Field>
        <Field
          label={jsonData.modelDiscovery === 'off' ? 'Other allowed models' : 'Model filter'}
          description={
            jsonData.modelDiscovery === 'off'
              ? 'Names users can pick in the chat; patterns like claude-* allow matching names. Anything else is rejected server-side.'
              : 'Optional names or patterns (claude-*, *sonnet*) limiting the discovered list. Empty: every chat model the endpoint lists. Requests for other models are rejected server-side.'
          }
        >
          <TagsInput tags={jsonData.allowedModels ?? []} onChange={(tags) => setJson({ allowedModels: tags })} width={60} />
        </Field>
        <ModelPreview uid={props.options.uid} saved={!!props.options.id && !!props.options.version} />
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
      <FieldSet label="Limits">
        <Text color="secondary" variant="bodySmall">
          Enforced by the Grafana backend for every caller, including scripts calling the API directly. Counters are per Grafana replica and
          reset on restart; tokens are input + output + cache writes, with cache reads at 10%. Leave empty for no limit.
        </Text>
        {(
          [
            ['maxConcurrentPerUser', 'Concurrent calls per user', 'Default 16 (three conversations with sub-agents); -1 for no limit', '16'],
            ['requestsPerMinutePerUser', 'Calls per minute per user', 'Rolling 60-second window', ''],
            ['tokensPerUserPerDay', 'Tokens per user per day', 'Resets at 00:00 UTC, e.g. 2000000', ''],
            ['tokensPerDay', 'Tokens per day (all users)', 'Resets at 00:00 UTC', ''],
          ] as const
        ).map(([key, label, description, placeholder]) => (
          <Field key={key} label={label} description={description}>
            <Input
              type="number"
              width={20}
              aria-label={label}
              value={jsonData.limits?.[key] ?? ''}
              placeholder={placeholder}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ limits: { ...jsonData.limits, [key]: numberOrUndefined(e.target.value) } })}
            />
          </Field>
        ))}
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
          <Field
            label="Read-only tools"
            description="Glob patterns of tools you vouch for as read-only. They run without per-call approval, are available to sub-agents and need only Viewer."
          >
            <TagsInput tags={srv.readOnlyTools ?? []} onChange={(tags) => set(i, { readOnlyTools: tags })} width={60} />
          </Field>
          <Field label="Role required for other tools" description="Enforced by the backend for every call, independently of the approval prompt">
            <RadioButtonGroup
              options={[
                { label: 'Viewer', value: 'Viewer' },
                { label: 'Editor', value: 'Editor' },
                { label: 'Admin', value: 'Admin' },
              ]}
              value={srv.writeRole ?? 'Editor'}
              onChange={(v) => set(i, { writeRole: v as McpServerConfig['writeRole'] })}
            />
          </Field>
          <Stack direction="row" gap={2} alignItems="center">
            <InlineSwitch
              label="Trust the server's readOnlyHint annotations"
              showLabel
              value={!!srv.trustReadOnlyHints}
              onChange={(e) => set(i, { trustReadOnlyHints: e.currentTarget.checked })}
            />
          </Stack>
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

interface ModelList {
  defaultModel: string;
  models: Array<{ id: string; name?: string }>;
  source: 'endpoint' | 'config';
  warning?: string;
}

/** Shows what the chat will offer, as the saved datasource sees it with your credentials. */
function ModelPreview({ uid, saved }: { uid: string; saved: boolean }) {
  const [state, setState] = React.useState<{ loading?: boolean; list?: ModelList; error?: string }>({});
  const load = async () => {
    setState({ loading: true });
    try {
      const res = await lastValueFrom(getBackendSrv().fetch<ModelList>({ url: `/api/datasources/uid/${uid}/resources/models`, params: { refresh: '1' }, showErrorAlert: false }));
      setState({ list: res.data });
    } catch (e) {
      const err = e as { data?: { error?: { message?: string }; message?: string }; status?: number };
      setState({ error: err.data?.error?.message ?? err.data?.message ?? `HTTP ${err.status ?? '?'}` });
    }
  };
  return (
    <Field label="Models offered in the chat" description={saved ? 'Uses the saved settings; save first after changing them.' : 'Save the datasource first.'}>
      <Stack direction="column" gap={1}>
        <div>
          <Button size="sm" variant="secondary" icon="sync" onClick={load} disabled={!saved || state.loading}>
            {state.loading ? 'Loading…' : 'Show models'}
          </Button>
        </div>
        {state.error && <Alert severity="error" title="Could not list models">{state.error}</Alert>}
        {state.list?.warning && <Alert severity="warning" title="">{state.list.warning}</Alert>}
        {state.list && (
          <div data-testid="augur-model-preview">
            {state.list.source === 'endpoint' ? 'From the endpoint' : 'From this configuration'} ({state.list.models.length}):{' '}
            {state.list.models.map((m) => (m.name && m.name !== m.id ? `${m.id} (${m.name})` : m.id)).join(', ')}
          </div>
        )}
      </Stack>
    </Field>
  );
}

/** CA certificates for internal gateways and MCP servers (e.g. LiteLLM behind a corporate CA). */
function TlsSection({ options, onOptionsChange }: Props) {
  const { jsonData, secureJsonFields, secureJsonData } = options;
  const setJson = (patch: Partial<ClaudeDataSourceOptions>) => onOptionsChange({ ...options, jsonData: { ...jsonData, ...patch } });
  return (
    <FieldSet label="TLS">
      <Field
        label="Add CA certificate"
        description="Trust an internal CA (PEM) for the endpoint and MCP servers, in addition to the system roots. Use this instead of skipping verification."
      >
        <Switch value={!!jsonData.tlsAuthWithCACert} onChange={(e) => setJson({ tlsAuthWithCACert: e.currentTarget.checked || undefined })} />
      </Field>
      {jsonData.tlsAuthWithCACert && (
        <Field label="CA certificate (PEM)">
          <SecretTextArea
            rows={6}
            cols={64}
            isConfigured={!!secureJsonFields?.tlsCACert}
            value={secureJsonData?.tlsCACert ?? ''}
            placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'}
            onReset={() =>
              onOptionsChange({ ...options, secureJsonFields: { ...secureJsonFields, tlsCACert: false }, secureJsonData: { ...secureJsonData, tlsCACert: '' } })
            }
            onChange={(e) => onOptionsChange({ ...options, secureJsonData: { ...secureJsonData, tlsCACert: e.currentTarget.value } })}
          />
        </Field>
      )}
      <Field
        label="CA bundle file"
        description="Or a PEM file on the Grafana server, e.g. a ConfigMap mounted into the pod (/etc/ssl/internal/ca.pem). Read when the datasource is saved or Grafana restarts."
      >
        <Input
          width={60}
          value={jsonData.tlsCACertFile ?? ''}
          placeholder="/etc/ssl/internal/ca.pem"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ tlsCACertFile: e.target.value || undefined })}
        />
      </Field>
      <Field label="Server name" description="Optional TLS server name (SNI) if it differs from the URL host">
        <Input width={40} value={jsonData.serverName ?? ''} onChange={(e: ChangeEvent<HTMLInputElement>) => setJson({ serverName: e.target.value || undefined })} />
      </Field>
      <Field label="Skip TLS verification" description="Insecure: accepts any certificate. Prefer adding the CA above.">
        <Switch value={!!jsonData.tlsSkipVerify} onChange={(e) => setJson({ tlsSkipVerify: e.currentTarget.checked || undefined })} />
      </Field>
      {jsonData.tlsSkipVerify && (
        <Alert severity="warning" title="TLS verification is off">
          Credentials and prompts are sent to whatever answers at this address. Add your CA certificate instead.
        </Alert>
      )}
    </FieldSet>
  );
}
