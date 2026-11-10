import { DataSourceJsonData } from '@grafana/data';
import { DataQuery } from '@grafana/schema';

export type AuthMethod = 'apiKey' | 'oauth' | 'none';
export type ApiKeyHeader = 'authorization' | 'x-api-key' | 'api-key';
export type ApiFormat = 'anthropic' | 'openai';
export type OAuthTokenType = 'access' | 'id';

/** Not used for panel queries; present to satisfy the datasource contract. */
export interface ClaudeQuery extends DataQuery {}

export interface ClaudeDataSourceOptions extends DataSourceJsonData {
  apiFormat?: ApiFormat;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  authMethod?: AuthMethod;
  apiKeyHeader?: ApiKeyHeader;
  /** Grafana's standard flag: forward the signed-in user's OAuth token to the plugin backend. */
  oauthPassThru?: boolean;
  oauthTokenType?: OAuthTokenType;
  messagesPath?: string;
  modelsPath?: string;
  anthropicVersion?: string;
  defaultModel?: string;
  allowedModels?: string[];
  /** Grafana's standard TLS settings (read by the plugin SDK). */
  tlsSkipVerify?: boolean;
  tlsAuthWithCACert?: boolean;
  serverName?: string;
  /** PEM bundle on disk (e.g. a mounted ConfigMap), trusted in addition to the system roots. */
  tlsCACertFile?: string;
  /** 'endpoint' (default): offer the models the endpoint lists for the caller; 'off': only the configured ones. */
  modelDiscovery?: 'endpoint' | 'off';
  maxTokens?: number;
  timeoutSeconds?: number;
  extraHeaders?: Record<string, string>;
  mcpServers?: McpServerConfig[];
}

export type McpAuth = 'none' | 'bearer' | 'header' | 'oauth';

export interface McpServerConfig {
  name: string;
  url: string;
  auth: McpAuth;
  headerName?: string;
  requireApproval?: boolean;
  allowedTools?: string[];
  readOnlyTools?: string[];
  trustReadOnlyHints?: boolean;
  writeRole?: 'Viewer' | 'Editor' | 'Admin';
}

export interface ClaudeSecureJsonData {
  apiKey?: string;
  tlsCACert?: string;
  /** mcpToken_<server name> */
  [key: string]: string | undefined;
}
