package plugin

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/AISolutionLabs/augur/augur-datasource/pkg/models"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

var (
	_ backend.CallResourceHandler   = (*Datasource)(nil)
	_ backend.CheckHealthHandler    = (*Datasource)(nil)
	_ backend.QueryDataHandler      = (*Datasource)(nil)
	_ instancemgmt.InstanceDisposer = (*Datasource)(nil)
)

const (
	maxRequestBytes  = 8 << 20  // 8 MiB of conversation + tool results
	maxResponseBytes = 16 << 20 // 16 MiB upstream response cap
)

// Datasource proxies Claude Messages API calls from the Grafana UI to a
// configured endpoint (Anthropic API, LiteLLM, or any Messages-compatible
// gateway), adding credentials server-side so they never reach the browser.
type Datasource struct {
	settings *models.PluginSettings
	client   *http.Client
	mcp      *mcpClient
	models   modelCache
	tlsErr   error // custom CA could not be loaded (reported by CheckHealth)
	resource backend.CallResourceHandler
	logger   log.Logger
}

// NewDatasource creates a datasource instance for one configured datasource.
func NewDatasource(ctx context.Context, instance backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	settings, err := models.LoadPluginSettings(instance)
	ds := &Datasource{settings: settings, logger: log.DefaultLogger}
	if err != nil {
		// Keep the instance so CheckHealth can report the problem in the UI.
		ds.logger.Warn("Claude datasource misconfigured", "error", err.Error())
	}

	opts, optErr := instance.HTTPClientOptions(ctx)
	if optErr != nil {
		return nil, fmt.Errorf("http client options: %w", optErr)
	}
	// Custom CAs are added to the system roots (the SDK would replace them, breaking public MCP
	// servers): the inline PEM from "Add CA certificate" and/or a mounted bundle file.
	inlineCA := ""
	if opts.TLS != nil {
		inlineCA, opts.TLS.CACertificate = opts.TLS.CACertificate, ""
	}
	roots, caErr := rootCAs(inlineCA, settings.TLSCACertFile)
	if caErr != nil {
		ds.tlsErr = caErr
		ds.logger.Warn("Custom CA certificates not loaded", "error", caErr.Error())
	}
	opts.ConfigureTLSConfig = func(_ httpclient.Options, c *tls.Config) {
		if roots != nil {
			c.RootCAs = roots
		}
	}
	// Per-request timeouts are applied with contexts; keep transport defaults for TLS/proxy/CA settings.
	opts.Timeouts.Timeout = 0
	// Never let the generic SDK middlewares add or forward auth: this plugin sets auth headers explicitly.
	opts.ForwardHTTPHeaders = false
	client, cErr := httpclient.New(opts)
	if cErr != nil {
		return nil, fmt.Errorf("http client: %w", cErr)
	}
	// Never follow redirects: Go only strips Authorization/Cookie on cross-host redirects, so
	// x-api-key, api-key and custom MCP headers would be re-sent to the redirect target.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	ds.client = client
	ds.mcp = newMCPClient(client)

	mux := http.NewServeMux()
	mux.HandleFunc("/messages", ds.handleMessages)
	mux.HandleFunc("/config", ds.handleConfig)
	mux.HandleFunc("/models", ds.handleModels)
	mux.HandleFunc("/mcp/tools", ds.handleMCPTools)
	mux.HandleFunc("/mcp/call", ds.handleMCPCall)
	ds.resource = httpadapter.New(mux)
	return ds, nil
}

// Dispose releases resources when settings change.
func (d *Datasource) Dispose() {
	if d.client != nil {
		d.client.CloseIdleConnections()
	}
}

// CallResource routes /api/datasources/uid/<uid>/resources/* requests.
func (d *Datasource) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	return d.resource.CallResource(ctx, req, sender)
}

// QueryData is not used: this datasource is a chat backend, not a time-series source.
func (d *Datasource) QueryData(_ context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	resp := backend.NewQueryDataResponse()
	for _, q := range req.Queries {
		resp.Responses[q.RefID] = backend.ErrDataResponse(backend.StatusBadRequest,
			"the Claude datasource is used by the Claude app; it cannot be queried from panels")
	}
	return resp, nil
}

// ---- auth ------------------------------------------------------------------

// errNoOAuthToken means Grafana did not forward a user token for this request.
var errNoOAuthToken = errors.New("no OAuth token was forwarded by Grafana: the user must sign in to Grafana through OAuth/OIDC, and 'Forward OAuth Identity' must be on for this datasource")

// applyAuth sets upstream credentials. incoming are the headers Grafana passed to the plugin.
func (d *Datasource) applyAuth(out *http.Request, incoming http.Header) error {
	s := d.settings
	switch s.AuthMethod {
	case models.AuthMethodAPIKey:
		switch s.APIKeyHeader {
		case models.APIKeyHeaderXAPIKey:
			out.Header.Set("x-api-key", s.Secrets.APIKey)
		case models.APIKeyHeaderAPIKey:
			out.Header.Set("api-key", s.Secrets.APIKey)
		default:
			out.Header.Set("Authorization", "Bearer "+s.Secrets.APIKey)
		}
	case models.AuthMethodOAuth:
		token, err := oauthToken(incoming, s.OAuthTokenType)
		if err != nil {
			return err
		}
		out.Header.Set("Authorization", "Bearer "+token)
	case models.AuthMethodNone:
	}
	return nil
}

// oauthToken extracts the forwarded token. Grafana's OAuth pass-through middleware
// sets "Authorization: <type> <access token>" and "X-ID-Token: <id token>".
func oauthToken(h http.Header, tokenType string) (string, error) {
	if tokenType == models.OAuthTokenID {
		if t := strings.TrimSpace(h.Get(backend.OAuthIdentityIDTokenHeaderName)); t != "" {
			return t, nil
		}
		return "", errNoOAuthToken
	}
	v := strings.TrimSpace(h.Get(backend.OAuthIdentityTokenHeaderName))
	if v == "" {
		return "", errNoOAuthToken
	}
	if i := strings.IndexByte(v, ' '); i > 0 && strings.EqualFold(v[:i], "bearer") {
		v = strings.TrimSpace(v[i+1:])
	}
	if v == "" {
		return "", errNoOAuthToken
	}
	return v, nil
}

func (d *Datasource) newUpstreamRequest(ctx context.Context, method, path string, body io.Reader, incoming http.Header) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.settings.URL+path, body)
	if err != nil {
		return nil, err
	}
	if d.settings.APIFormat != models.APIFormatOpenAI {
		req.Header.Set("anthropic-version", d.settings.AnthropicVersion)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range d.settings.ExtraHeaders {
		// Credentials are only ever set by applyAuth.
		if isAuthHeader(k) {
			continue
		}
		req.Header.Set(k, v)
	}
	if err := d.applyAuth(req, incoming); err != nil {
		return nil, err
	}
	return req, nil
}

func isAuthHeader(k string) bool {
	switch strings.ToLower(k) {
	case "authorization", "x-api-key", "api-key", "cookie", "proxy-authorization":
		return true
	}
	return false
}

// ---- /messages ---------------------------------------------------------------

// messagesRequest is the subset of the Messages API the browser may set.
// Anything else (model overrides beyond the allow-list, unbounded max_tokens,
// streaming, arbitrary fields) is dropped or clamped server-side.
type messagesRequest struct {
	Model         string            `json:"model,omitempty"`
	System        json.RawMessage   `json:"system,omitempty"`
	Messages      json.RawMessage   `json:"messages"`
	Tools         json.RawMessage   `json:"tools,omitempty"`
	ToolChoice    json.RawMessage   `json:"tool_choice,omitempty"`
	MaxTokens     int               `json:"max_tokens,omitempty"`
	Temperature   *float64          `json:"temperature,omitempty"`
	StopSequences []string          `json:"stop_sequences,omitempty"`
	Thinking      json.RawMessage   `json:"thinking,omitempty"`
	Metadata      map[string]string `json:"-"`
}

type upstreamBody struct {
	Model         string            `json:"model"`
	System        json.RawMessage   `json:"system,omitempty"`
	Messages      json.RawMessage   `json:"messages"`
	Tools         json.RawMessage   `json:"tools,omitempty"`
	ToolChoice    json.RawMessage   `json:"tool_choice,omitempty"`
	MaxTokens     int               `json:"max_tokens"`
	Temperature   *float64          `json:"temperature,omitempty"`
	StopSequences []string          `json:"stop_sequences,omitempty"`
	Thinking      json.RawMessage   `json:"thinking,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

func (d *Datasource) handleMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err := d.settings.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "datasource misconfigured: "+err.Error())
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not read request body")
		return
	}
	if len(raw) > maxRequestBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "conversation too large; start a new chat")
		return
	}
	var in messagesRequest
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if len(in.Messages) == 0 || string(in.Messages) == "null" {
		writeError(w, http.StatusBadRequest, "messages is required")
		return
	}

	model := d.settings.DefaultModel
	if in.Model != "" {
		if !d.modelAllowed(r.Context(), r.Header, in.Model) {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("model %q is not allowed by this datasource", in.Model))
			return
		}
		model = in.Model
	}
	maxTokens := d.settings.MaxTokens
	if in.MaxTokens > 0 && in.MaxTokens < maxTokens {
		maxTokens = in.MaxTokens
	}

	out := upstreamBody{
		Model:         model,
		System:        in.System,
		Messages:      in.Messages,
		Tools:         in.Tools,
		ToolChoice:    in.ToolChoice,
		MaxTokens:     maxTokens,
		Temperature:   in.Temperature,
		StopSequences: in.StopSequences,
		Thinking:      in.Thinking,
	}
	// Attribute usage to the Grafana user (LiteLLM and Anthropic both accept metadata.user_id).
	if cfg := backend.PluginConfigFromContext(r.Context()); cfg.User != nil && cfg.User.Login != "" {
		out.Metadata = map[string]string{"user_id": cfg.User.Login}
	}
	var body []byte
	if d.settings.APIFormat == models.APIFormatOpenAI {
		oai, terr := toOpenAI(out, d.settings.MaxTokensField)
		if terr != nil {
			writeError(w, http.StatusBadRequest, "could not translate request: "+terr.Error())
			return
		}
		body, err = json.Marshal(oai)
	} else {
		body, err = json.Marshal(out)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not encode request")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(d.settings.TimeoutSeconds)*time.Second)
	defer cancel()
	req, err := d.newUpstreamRequest(ctx, http.MethodPost, d.settings.MessagesPath, bytes.NewReader(body), r.Header)
	if err != nil {
		if errors.Is(err, errNoOAuthToken) {
			writeError(w, http.StatusUnauthorized, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	start := time.Now()
	resp, err := d.client.Do(req)
	if err != nil {
		d.logger.Warn("Claude upstream request failed", "error", err.Error())
		writeError(w, http.StatusBadGateway, "could not reach the Claude endpoint: "+redact(err.Error()))
		return
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		writeError(w, http.StatusBadGateway, "error reading upstream response")
		return
	}
	d.logger.Debug("Claude upstream call", "status", resp.StatusCode, "model", model, "duration", time.Since(start).String())

	status := resp.StatusCode
	if d.settings.APIFormat == models.APIFormatOpenAI {
		status, respBody = fromOpenAI(status, respBody)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(respBody)
}

// ---- /config -------------------------------------------------------------

type publicConfig struct {
	DefaultModel string            `json:"defaultModel"`
	Models       []string          `json:"models"`
	ModelNames   map[string]string `json:"modelNames,omitempty"`
	ModelSource  string            `json:"modelSource"`
	ModelWarning string            `json:"modelWarning,omitempty"`
	MaxTokens    int               `json:"maxTokens"`
	AuthMethod   string            `json:"authMethod"`
	APIFormat    string            `json:"apiFormat"`
	MCPServers   []string          `json:"mcpServers"`
}

// handleConfig exposes the non-secret settings the chat UI needs.
func (d *Datasource) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	names := []string{}
	for _, m := range d.settings.MCPServers {
		names = append(names, m.Name)
	}
	listing := d.availableModels(r.Context(), r.Header)
	ids := make([]string, 0, len(listing.models))
	labels := map[string]string{}
	for _, m := range listing.models {
		ids = append(ids, m.ID)
		if m.Name != "" {
			labels[m.ID] = m.Name
		}
	}
	_ = json.NewEncoder(w).Encode(publicConfig{
		DefaultModel: d.settings.DefaultModel,
		Models:       ids,
		ModelNames:   labels,
		ModelSource:  listing.source,
		ModelWarning: listing.warning,
		MaxTokens:    d.settings.MaxTokens,
		AuthMethod:   d.settings.AuthMethod,
		APIFormat:    d.settings.APIFormat,
		MCPServers:   names,
	})
}

// ---- health --------------------------------------------------------------

// CheckHealth verifies configuration, connectivity and credentials by listing models.
// In OAuth mode it uses the token of the admin pressing "Save & test".
func (d *Datasource) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if err := d.settings.Validate(); err != nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: err.Error()}, nil
	}
	if d.tlsErr != nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: "CA certificate: " + d.tlsErr.Error()}, nil
	}
	incoming := http.Header{}
	for k, v := range req.Headers {
		incoming.Set(k, v)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	up, err := d.newUpstreamRequest(ctx, http.MethodGet, d.settings.ModelsPath, nil, incoming)
	if err != nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: err.Error()}, nil
	}
	resp, err := d.client.Do(up)
	if err != nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: "could not reach endpoint: " + redact(err.Error())}, nil
	}
	defer resp.Body.Close()
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	switch {
	case resp.StatusCode == http.StatusOK:
		return &backend.CheckHealthResult{Status: backend.HealthStatusOk,
			Message: fmt.Sprintf("Connected to %s (%s auth). Default model: %s", d.settings.URL, d.settings.AuthMethod, d.settings.DefaultModel)}, nil
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return &backend.CheckHealthResult{Status: backend.HealthStatusError,
			Message: fmt.Sprintf("Endpoint rejected the credentials (HTTP %d): %s", resp.StatusCode, truncate(string(snippet), 300))}, nil
	case resp.StatusCode == http.StatusNotFound:
		return &backend.CheckHealthResult{Status: backend.HealthStatusUnknown,
			Message: fmt.Sprintf("Reached the endpoint but %s returned 404. Check the URL; chat may still work if only %s is exposed.", d.settings.ModelsPath, d.settings.MessagesPath)}, nil
	default:
		return &backend.CheckHealthResult{Status: backend.HealthStatusError,
			Message: fmt.Sprintf("Unexpected HTTP %d from %s: %s", resp.StatusCode, d.settings.ModelsPath, truncate(string(snippet), 300))}, nil
	}
}

// ---- helpers ---------------------------------------------------------------

// writeError returns errors in the Anthropic error envelope so the UI has one format to parse.
func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":  "error",
		"error": map[string]string{"type": "grafana_plugin_error", "message": msg},
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// redact strips URL userinfo that net/http errors can echo back.
func redact(s string) string {
	if i := strings.Index(s, "://"); i >= 0 {
		if at := strings.Index(s[i+3:], "@"); at >= 0 && !strings.ContainsAny(s[i+3:i+3+at], "/ ") {
			return s[:i+3] + "***" + s[i+3+at:]
		}
	}
	return s
}

// rootCAs returns the system roots plus the given PEM CAs, or nil when none are configured.
func rootCAs(inlinePEM, file string) (*x509.CertPool, error) {
	if strings.TrimSpace(inlinePEM) == "" && file == "" {
		return nil, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if strings.TrimSpace(inlinePEM) != "" && !pool.AppendCertsFromPEM([]byte(inlinePEM)) {
		return nil, fmt.Errorf("the CA certificate is not valid PEM")
	}
	if file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("could not read CA file: %w", err)
		}
		if !pool.AppendCertsFromPEM(b) {
			return nil, fmt.Errorf("no PEM certificates in %s", file)
		}
	}
	return pool, nil
}
