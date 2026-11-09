import { DataSourceJsonData } from '@grafana/data';
import { DataQuery } from '@grafana/schema';

export type AuthMethod = 'apiKey' | 'oauth' | 'none';
export type ApiKeyHeader = 'authorization' | 'x-api-key';
export type OAuthTokenType = 'access' | 'id';

/** Not used for panel queries; present to satisfy the datasource contract. */
export interface ClaudeQuery extends DataQuery {}

export interface ClaudeDataSourceOptions extends DataSourceJsonData {
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
  maxTokens?: number;
  timeoutSeconds?: number;
  extraHeaders?: Record<string, string>;
}

export interface ClaudeSecureJsonData {
  apiKey?: string;
}
