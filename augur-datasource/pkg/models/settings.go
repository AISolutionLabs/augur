package models

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// Auth methods for calling the Claude endpoint.
const (
	AuthMethodAPIKey = "apiKey" // static key stored in secureJsonData
	AuthMethodOAuth  = "oauth"  // forward the signed-in Grafana user's OAuth token
	AuthMethodNone   = "none"   // no auth header (e.g. mTLS or network-level auth)
)

// Which header carries the static API key.
const (
	APIKeyHeaderAuthorization = "authorization" // Authorization: Bearer <key> (LiteLLM virtual keys, OpenAI)
	APIKeyHeaderXAPIKey       = "x-api-key"     // x-api-key: <key> (Anthropic API)
	APIKeyHeaderAPIKey        = "api-key"       // api-key: <key> (Azure OpenAI)
)

// Wire format of the model endpoint.
const (
	APIFormatAnthropic = "anthropic" // Claude Messages API (/v1/messages): Anthropic, LiteLLM, Bedrock gateways
	APIFormatOpenAI    = "openai"    // Chat Completions (/v1/chat/completions): Azure OpenAI, vLLM, Ollama, OpenAI
)

// Which OAuth token to forward when AuthMethod is oauth.
const (
	OAuthTokenAccess = "access" // the OAuth access token (Authorization header from Grafana)
	OAuthTokenID     = "id"     // the OIDC ID token (X-ID-Token header from Grafana)
)

const (
	DefaultMessagesPath     = "/v1/messages"
	DefaultModelsPath       = "/v1/models"
	DefaultAnthropicVersion = "2023-06-01"
	DefaultModel            = "claude-sonnet-5-5"
	DefaultMaxTokens        = 8192
	DefaultTimeoutSeconds   = 300
)

// PluginSettings is the non-secret configuration stored in jsonData.
type PluginSettings struct {
	URL string `json:"-"`

	APIFormat string `json:"apiFormat"`
	// For openai format: "max_tokens" (default) or "max_completion_tokens" (newer OpenAI models).
	MaxTokensField string `json:"maxTokensField"`
	AuthMethod     string `json:"authMethod"`
	APIKeyHeader   string `json:"apiKeyHeader"`
	OAuthPassThru  bool   `json:"oauthPassThru"` // must be true for Grafana to forward the user's token
	OAuthTokenType string `json:"oauthTokenType"`

	MessagesPath     string   `json:"messagesPath"`
	ModelsPath       string   `json:"modelsPath"`
	AnthropicVersion string   `json:"anthropicVersion"`
	DefaultModel     string   `json:"defaultModel"`
	AllowedModels    []string `json:"allowedModels"`
	MaxTokens        int      `json:"maxTokens"`
	TimeoutSeconds   int      `json:"timeoutSeconds"`
	// Optional extra static headers sent upstream (e.g. LiteLLM tags). Values are not secret.
	ExtraHeaders map[string]string `json:"extraHeaders"`

	// MCP servers whose tools Augur may use, proxied through this backend.
	MCPServers []MCPServer `json:"mcpServers"`

	Secrets *SecretPluginSettings `json:"-"`
}

// MCP server auth modes.
const (
	MCPAuthNone   = "none"   // no credentials
	MCPAuthBearer = "bearer" // Authorization: Bearer <secureJsonData mcpToken_<name>>
	MCPAuthHeader = "header" // <headerName>: <secureJsonData mcpToken_<name>>
	MCPAuthOAuth  = "oauth"  // forward the signed-in user's OAuth token (requires oauthPassThru)
)

// MCPServer configures one remote MCP server (streamable HTTP transport).
type MCPServer struct {
	Name       string `json:"name"`
	URL        string `json:"url"`
	Auth       string `json:"auth"`
	HeaderName string `json:"headerName,omitempty"`
	// RequireApproval: tools not annotated read-only need a user click before running. Default true.
	RequireApproval *bool `json:"requireApproval,omitempty"`
	// AllowedTools: optional glob patterns (path.Match) of tool names to expose. Empty = all.
	AllowedTools []string `json:"allowedTools,omitempty"`
}

// NeedsApproval reports whether non-read-only tools require user approval.
func (m MCPServer) NeedsApproval() bool { return m.RequireApproval == nil || *m.RequireApproval }

// SecretPluginSettings is stored encrypted in secureJsonData.
type SecretPluginSettings struct {
	APIKey string
	// MCPTokens maps server name -> secret (from secureJsonData key "mcpToken_<name>").
	MCPTokens map[string]string
}

// LoadPluginSettings parses and validates instance settings, applying defaults.
func LoadPluginSettings(source backend.DataSourceInstanceSettings) (*PluginSettings, error) {
	s := PluginSettings{}
	if len(source.JSONData) > 0 {
		if err := json.Unmarshal(source.JSONData, &s); err != nil {
			return nil, fmt.Errorf("could not unmarshal settings json: %w", err)
		}
	}
	s.URL = strings.TrimRight(strings.TrimSpace(source.URL), "/")
	s.Secrets = &SecretPluginSettings{APIKey: strings.TrimSpace(source.DecryptedSecureJSONData["apiKey"]), MCPTokens: map[string]string{}}
	for k, v := range source.DecryptedSecureJSONData {
		if strings.HasPrefix(k, "mcpToken_") {
			s.Secrets.MCPTokens[strings.TrimPrefix(k, "mcpToken_")] = strings.TrimSpace(v)
		}
	}
	s.applyDefaults()
	return &s, s.Validate()
}

func (s *PluginSettings) applyDefaults() {
	if s.AuthMethod == "" {
		s.AuthMethod = AuthMethodAPIKey
	}
	if s.APIKeyHeader == "" {
		s.APIKeyHeader = APIKeyHeaderAuthorization
	}
	if s.OAuthTokenType == "" {
		s.OAuthTokenType = OAuthTokenAccess
	}
	if s.APIFormat == "" {
		s.APIFormat = APIFormatAnthropic
	}
	if s.MessagesPath == "" {
		s.MessagesPath = DefaultMessagesPath
		if s.APIFormat == APIFormatOpenAI {
			s.MessagesPath = "/v1/chat/completions"
		}
	}
	if s.ModelsPath == "" {
		s.ModelsPath = DefaultModelsPath
	}
	if s.AnthropicVersion == "" {
		s.AnthropicVersion = DefaultAnthropicVersion
	}
	if s.DefaultModel == "" {
		s.DefaultModel = DefaultModel
	}
	if s.MaxTokens <= 0 {
		s.MaxTokens = DefaultMaxTokens
	}
	if s.TimeoutSeconds <= 0 {
		s.TimeoutSeconds = DefaultTimeoutSeconds
	}
	cleaned := make([]string, 0, len(s.AllowedModels))
	for _, m := range s.AllowedModels {
		if m = strings.TrimSpace(m); m != "" {
			cleaned = append(cleaned, m)
		}
	}
	s.AllowedModels = cleaned
}

// Validate reports configuration errors that make the datasource unusable.
func (s *PluginSettings) Validate() error {
	if s.URL == "" {
		return fmt.Errorf("URL is required (e.g. https://litellm.example.internal or https://api.anthropic.com)")
	}
	u, err := url.Parse(s.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("URL must be an absolute http(s) URL, got %q", s.URL)
	}
	switch s.AuthMethod {
	case AuthMethodAPIKey:
		if s.Secrets == nil || s.Secrets.APIKey == "" {
			return fmt.Errorf("auth method is API key but no API key is configured")
		}
		if s.APIKeyHeader != APIKeyHeaderAuthorization && s.APIKeyHeader != APIKeyHeaderXAPIKey && s.APIKeyHeader != APIKeyHeaderAPIKey {
			return fmt.Errorf("apiKeyHeader must be %q, %q or %q", APIKeyHeaderAuthorization, APIKeyHeaderXAPIKey, APIKeyHeaderAPIKey)
		}
	case AuthMethodOAuth:
		if !s.OAuthPassThru {
			return fmt.Errorf("auth method is OAuth but 'Forward OAuth Identity' (oauthPassThru) is off, so Grafana will not pass the user's token")
		}
		if s.OAuthTokenType != OAuthTokenAccess && s.OAuthTokenType != OAuthTokenID {
			return fmt.Errorf("oauthTokenType must be %q or %q", OAuthTokenAccess, OAuthTokenID)
		}
	case AuthMethodNone:
	default:
		return fmt.Errorf("unknown authMethod %q", s.AuthMethod)
	}
	if s.APIFormat != APIFormatAnthropic && s.APIFormat != APIFormatOpenAI {
		return fmt.Errorf("apiFormat must be %q or %q", APIFormatAnthropic, APIFormatOpenAI)
	}
	if s.MaxTokensField != "" && s.MaxTokensField != "max_tokens" && s.MaxTokensField != "max_completion_tokens" {
		return fmt.Errorf("maxTokensField must be max_tokens or max_completion_tokens")
	}
	seen := map[string]bool{}
	for _, m := range s.MCPServers {
		if m.Name == "" || seen[m.Name] {
			return fmt.Errorf("MCP servers need unique, non-empty names")
		}
		seen[m.Name] = true
		if u, err := url.Parse(m.URL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("MCP server %q: URL must be an absolute http(s) URL", m.Name)
		}
		switch m.Auth {
		case "", MCPAuthNone, MCPAuthBearer, MCPAuthHeader:
		case MCPAuthOAuth:
			if !s.OAuthPassThru {
				return fmt.Errorf("MCP server %q uses OAuth forwarding but 'Forward OAuth Identity' is off", m.Name)
			}
		default:
			return fmt.Errorf("MCP server %q: unknown auth %q", m.Name, m.Auth)
		}
		if m.Auth == MCPAuthHeader && m.HeaderName == "" {
			return fmt.Errorf("MCP server %q: headerName is required for header auth", m.Name)
		}
	}
	for _, p := range []string{s.MessagesPath, s.ModelsPath} {
		if !strings.HasPrefix(p, "/") {
			return fmt.Errorf("paths must start with '/', got %q", p)
		}
	}
	return nil
}

// Models returns the models the frontend may request, default first.
func (s *PluginSettings) Models() []string {
	out := []string{s.DefaultModel}
	for _, m := range s.AllowedModels {
		if m != s.DefaultModel {
			out = append(out, m)
		}
	}
	return out
}

// IsModelAllowed reports whether the frontend may request this model.
func (s *PluginSettings) IsModelAllowed(m string) bool {
	for _, x := range s.Models() {
		if x == m {
			return true
		}
	}
	return false
}
