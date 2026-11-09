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
	APIKeyHeaderAuthorization = "authorization" // Authorization: Bearer <key> (LiteLLM virtual keys)
	APIKeyHeaderXAPIKey       = "x-api-key"     // x-api-key: <key> (Anthropic API)
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

	Secrets *SecretPluginSettings `json:"-"`
}

// SecretPluginSettings is stored encrypted in secureJsonData.
type SecretPluginSettings struct {
	APIKey string
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
	s.Secrets = &SecretPluginSettings{APIKey: strings.TrimSpace(source.DecryptedSecureJSONData["apiKey"])}
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
	if s.MessagesPath == "" {
		s.MessagesPath = DefaultMessagesPath
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
		if s.APIKeyHeader != APIKeyHeaderAuthorization && s.APIKeyHeader != APIKeyHeaderXAPIKey {
			return fmt.Errorf("apiKeyHeader must be %q or %q", APIKeyHeaderAuthorization, APIKeyHeaderXAPIKey)
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
