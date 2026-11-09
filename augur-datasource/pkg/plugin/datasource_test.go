package plugin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

type captured struct {
	mu      sync.Mutex
	headers http.Header
	body    map[string]any
	path    string
}

func upstream(t *testing.T, status int, reply string) (*httptest.Server, *captured) {
	t.Helper()
	c := &captured{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.headers = r.Header.Clone()
		c.path = r.URL.Path
		if r.Body != nil {
			b, _ := io.ReadAll(r.Body)
			if len(b) > 0 {
				_ = json.Unmarshal(b, &c.body)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv, c
}

func newDS(t *testing.T, url string, jsonData string, secure map[string]string) *Datasource {
	t.Helper()
	inst, err := NewDatasource(context.Background(), backend.DataSourceInstanceSettings{
		URL:                     url,
		JSONData:                []byte(jsonData),
		DecryptedSecureJSONData: secure,
	})
	if err != nil {
		t.Fatalf("NewDatasource: %v", err)
	}
	return inst.(*Datasource)
}

type sender struct {
	status int
	body   []byte
}

func (s *sender) Send(r *backend.CallResourceResponse) error {
	s.status = r.Status
	s.body = append(s.body, r.Body...)
	return nil
}

func callMessages(t *testing.T, ds *Datasource, body string, headers map[string][]string, user *backend.User) *sender {
	t.Helper()
	s := &sender{}
	req := &backend.CallResourceRequest{
		PluginContext: backend.PluginContext{User: user},
		Path:          "messages",
		Method:        http.MethodPost,
		URL:           "messages",
		Headers:       headers,
		Body:          []byte(body),
	}
	ctx := backend.WithPluginContext(context.Background(), req.PluginContext)
	if err := ds.CallResource(ctx, req, s); err != nil {
		t.Fatalf("CallResource: %v", err)
	}
	return s
}

const okReply = `{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn"}`
const minimalBody = `{"messages":[{"role":"user","content":"hello"}]}`

func TestAPIKeyBearer(t *testing.T) {
	srv, c := upstream(t, 200, okReply)
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","defaultModel":"claude-x"}`, map[string]string{"apiKey": "sk-litellm"})
	// A browser-supplied Authorization header must never be forwarded in API-key mode.
	s := callMessages(t, ds, minimalBody, map[string][]string{"Authorization": {"Bearer user-token"}}, &backend.User{Login: "alice"})
	if s.status != 200 {
		t.Fatalf("status %d body %s", s.status, s.body)
	}
	if got := c.headers.Get("Authorization"); got != "Bearer sk-litellm" {
		t.Fatalf("Authorization = %q", got)
	}
	if c.headers.Get("anthropic-version") != "2023-06-01" {
		t.Fatalf("missing anthropic-version")
	}
	if c.path != "/v1/messages" {
		t.Fatalf("path %s", c.path)
	}
	if c.body["model"] != "claude-x" {
		t.Fatalf("model %v", c.body["model"])
	}
	if md, _ := c.body["metadata"].(map[string]any); md["user_id"] != "alice" {
		t.Fatalf("metadata %v", c.body["metadata"])
	}
}

func TestAPIKeyXAPIKeyHeader(t *testing.T) {
	srv, c := upstream(t, 200, okReply)
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","apiKeyHeader":"x-api-key"}`, map[string]string{"apiKey": "sk-ant"})
	callMessages(t, ds, minimalBody, nil, nil)
	if c.headers.Get("x-api-key") != "sk-ant" || c.headers.Get("Authorization") != "" {
		t.Fatalf("headers %v", c.headers)
	}
}

func TestOAuthAccessTokenForwarded(t *testing.T) {
	srv, c := upstream(t, 200, okReply)
	ds := newDS(t, srv.URL, `{"authMethod":"oauth","oauthPassThru":true}`, nil)
	// Grafana's OAuth pass-through middleware sets these on the plugin request.
	s := callMessages(t, ds, minimalBody, map[string][]string{
		backend.OAuthIdentityTokenHeaderName:   {"Bearer entra-access-token"},
		backend.OAuthIdentityIDTokenHeaderName: {"entra-id-token"},
	}, nil)
	if s.status != 200 {
		t.Fatalf("status %d %s", s.status, s.body)
	}
	if got := c.headers.Get("Authorization"); got != "Bearer entra-access-token" {
		t.Fatalf("Authorization = %q", got)
	}
}

func TestOAuthIDTokenForwarded(t *testing.T) {
	srv, c := upstream(t, 200, okReply)
	ds := newDS(t, srv.URL, `{"authMethod":"oauth","oauthPassThru":true,"oauthTokenType":"id"}`, nil)
	callMessages(t, ds, minimalBody, map[string][]string{
		backend.OAuthIdentityTokenHeaderName:   {"Bearer access"},
		backend.OAuthIdentityIDTokenHeaderName: {"the-id-token"},
	}, nil)
	if got := c.headers.Get("Authorization"); got != "Bearer the-id-token" {
		t.Fatalf("Authorization = %q", got)
	}
}

func TestOAuthMissingTokenIs401AndNoUpstreamCall(t *testing.T) {
	srv, c := upstream(t, 200, okReply)
	ds := newDS(t, srv.URL, `{"authMethod":"oauth","oauthPassThru":true}`, nil)
	s := callMessages(t, ds, minimalBody, nil, nil)
	if s.status != http.StatusUnauthorized {
		t.Fatalf("status %d", s.status)
	}
	if c.headers != nil {
		t.Fatalf("upstream should not be called")
	}
	if !strings.Contains(string(s.body), "Forward OAuth Identity") {
		t.Fatalf("unhelpful error: %s", s.body)
	}
}

func TestModelAllowListAndMaxTokensClamp(t *testing.T) {
	srv, c := upstream(t, 200, okReply)
	ds := newDS(t, srv.URL, `{"authMethod":"none","defaultModel":"a","allowedModels":["b"],"maxTokens":1000}`, nil)

	s := callMessages(t, ds, `{"model":"evil","messages":[{"role":"user","content":"x"}]}`, nil, nil)
	if s.status != http.StatusBadRequest {
		t.Fatalf("disallowed model: status %d", s.status)
	}
	s = callMessages(t, ds, `{"model":"b","max_tokens":99999,"messages":[{"role":"user","content":"x"}],"stream":true}`, nil, nil)
	if s.status != 200 {
		t.Fatalf("status %d", s.status)
	}
	if c.body["model"] != "b" || c.body["max_tokens"].(float64) != 1000 {
		t.Fatalf("body %v", c.body)
	}
	if _, ok := c.body["stream"]; ok {
		t.Fatalf("stream must be stripped")
	}
}

func TestUpstreamErrorPassedThrough(t *testing.T) {
	srv, _ := upstream(t, 429, `{"type":"error","error":{"type":"rate_limit_error","message":"budget exceeded"}}`)
	ds := newDS(t, srv.URL, `{"authMethod":"none"}`, nil)
	s := callMessages(t, ds, minimalBody, nil, nil)
	if s.status != 429 || !strings.Contains(string(s.body), "budget exceeded") {
		t.Fatalf("got %d %s", s.status, s.body)
	}
}

func TestMisconfiguredRejected(t *testing.T) {
	ds := newDS(t, "http://example.invalid", `{"authMethod":"apiKey"}`, nil) // no key
	s := callMessages(t, ds, minimalBody, nil, nil)
	if s.status != http.StatusBadRequest || !strings.Contains(string(s.body), "no API key") {
		t.Fatalf("got %d %s", s.status, s.body)
	}
}

func TestConfigEndpointHasNoSecrets(t *testing.T) {
	ds := newDS(t, "http://x.example", `{"authMethod":"apiKey","defaultModel":"a","allowedModels":["b","a"]}`, map[string]string{"apiKey": "sk-secret"})
	s := &sender{}
	req := &backend.CallResourceRequest{Path: "config", URL: "config", Method: http.MethodGet}
	if err := ds.CallResource(context.Background(), req, s); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(s.body), "sk-secret") {
		t.Fatal("secret leaked")
	}
	var cfg publicConfig
	_ = json.Unmarshal(s.body, &cfg)
	if cfg.DefaultModel != "a" || len(cfg.Models) != 2 {
		t.Fatalf("cfg %+v", cfg)
	}
}

func TestCheckHealth(t *testing.T) {
	srv, c := upstream(t, 200, `{"data":[]}`)
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey"}`, map[string]string{"apiKey": "k"})
	res, _ := ds.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
	if res.Status != backend.HealthStatusOk || c.path != "/v1/models" {
		t.Fatalf("health %v %s path %s", res.Status, res.Message, c.path)
	}

	bad, _ := upstream(t, 401, `{"error":"invalid key"}`)
	ds = newDS(t, bad.URL, `{"authMethod":"apiKey"}`, map[string]string{"apiKey": "k"})
	res, _ = ds.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
	if res.Status != backend.HealthStatusError || !strings.Contains(res.Message, "rejected") {
		t.Fatalf("health %v %s", res.Status, res.Message)
	}

	ds = newDS(t, srv.URL, `{"authMethod":"oauth","oauthPassThru":false}`, nil)
	res, _ = ds.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
	if res.Status != backend.HealthStatusError || !strings.Contains(res.Message, "oauthPassThru") {
		t.Fatalf("health %v %s", res.Status, res.Message)
	}
}

func TestExtraHeadersCannotOverrideAuth(t *testing.T) {
	srv, c := upstream(t, 200, okReply)
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","extraHeaders":{"Authorization":"Bearer hijack","x-litellm-tags":"grafana"}}`, map[string]string{"apiKey": "real"})
	callMessages(t, ds, minimalBody, nil, nil)
	if c.headers.Get("Authorization") != "Bearer real" || c.headers.Get("x-litellm-tags") != "grafana" {
		t.Fatalf("headers %v", c.headers)
	}
}

func TestRedact(t *testing.T) {
	if got := redact(`Post "https://user:pass@host/v1": dial`); strings.Contains(got, "pass") {
		t.Fatalf("not redacted: %s", got)
	}
}
