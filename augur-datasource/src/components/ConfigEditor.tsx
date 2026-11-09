import React, { ChangeEvent } from 'react';
import { Alert, Field, FieldSet, Input, RadioButtonGroup, SecretInput, Switch, TagsInput, Stack } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { ApiKeyHeader, AuthMethod, ClaudeDataSourceOptions, ClaudeSecureJsonData, OAuthTokenType } from '../types';

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
