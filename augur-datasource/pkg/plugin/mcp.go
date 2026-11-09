package plugin

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/AISolutionLabs/augur/augur-datasource/pkg/models"
)

// Minimal MCP client for the streamable HTTP transport (JSON-RPC 2.0 over POST; responses as
// application/json or text/event-stream). Sessions are cached per server and caller identity.

const (
	mcpProtocolVersion = "2025-06-18"
	mcpSessionTTL      = 10 * time.Minute
	mcpToolsTTL        = 5 * time.Minute
	mcpErrorTTL        = 30 * time.Second // failed discovery is cached briefly so a down server isn't hammered
	mcpCallTimeout     = 120 * time.Second
	mcpMaxBody         = 8 << 20
	mcpMaxToolPages    = 50  // tools/list pages followed per server
	mcpMaxTools        = 512 // tools exposed per server (each costs prompt tokens on every model call)
	mcpSweepInterval   = time.Minute
	mcpSharedWorkLimit = 30 * time.Second // deadline for work shared by concurrent callers (init, discovery)
)

type mcpSession struct {
	id      string
	expires time.Time
}

type toolsEntry struct {
	tools   []json.RawMessage
	warning string
	err     error
	at      time.Time
}

type mcpClient struct {
	http      *http.Client
	maxBody   int64
	mu        sync.Mutex
	sessions  map[string]*mcpSession
	tools     map[string]*toolsEntry
	lastSweep time.Time
	flight    flightGroup
	nextID    atomic.Int64
}

func newMCPClient(h *http.Client) *mcpClient {
	return &mcpClient{http: h, maxBody: mcpMaxBody, sessions: map[string]*mcpSession{}, tools: map[string]*toolsEntry{}}
}

// flightGroup collapses concurrent calls for the same key into one (a minimal singleflight, kept
// local to avoid adding a dependency to the plugin's module graph).
type flightGroup struct {
	mu    sync.Mutex
	calls map[string]*flightCall
}

type flightCall struct {
	done chan struct{}
	val  any
	err  error
}

func (g *flightGroup) do(key string, fn func() (any, error)) (any, error) {
	g.mu.Lock()
	if g.calls == nil {
		g.calls = map[string]*flightCall{}
	}
	if c, ok := g.calls[key]; ok {
		g.mu.Unlock()
		<-c.done
		return c.val, c.err
	}
	c := &flightCall{done: make(chan struct{})}
	g.calls[key] = c
	g.mu.Unlock()

	c.val, c.err = fn()
	g.mu.Lock()
	delete(g.calls, key)
	g.mu.Unlock()
	close(c.done)
	return c.val, c.err
}

// sharedContext detaches shared work from the first caller's cancellation (one user closing a tab
// must not fail everyone waiting on the same initialize/discovery) while keeping a deadline.
func sharedContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), mcpSharedWorkLimit)
}

// errResponseTooLarge is returned when an MCP response exceeds the body limit, instead of a
// truncated-JSON or "stream ended" error that would hide the cause.
type errResponseTooLarge struct{ limit int64 }

func (e errResponseTooLarge) Error() string {
	return fmt.Sprintf("MCP response exceeds the %d MiB limit; narrow the tool arguments (fewer results, smaller range)", e.limit>>20)
}

// capReader passes through at most limit bytes and fails loudly if the body is longer.
type capReader struct {
	r         io.Reader
	remaining int64
	limit     int64
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.remaining <= 0 {
		var probe [1]byte
		n, err := c.r.Read(probe[:])
		if n > 0 {
			return 0, errResponseTooLarge{c.limit}
		}
		return 0, err
	}
	if int64(len(p)) > c.remaining {
		p = p[:c.remaining]
	}
	n, err := c.r.Read(p)
	c.remaining -= int64(n)
	return n, err
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

// errSessionGone signals an expired/unknown MCP session (HTTP 404); the caller re-initializes.
var errSessionGone = errors.New("mcp session expired")

func identityKey(server string, auth http.Header) string {
	keys := make([]string, 0, len(auth))
	for k := range auth {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	h.Write([]byte(server))
	for _, k := range keys {
		h.Write([]byte{0})
		h.Write([]byte(k))
		h.Write([]byte{0})
		h.Write([]byte(strings.Join(auth[k], ",")))
	}
	return hex.EncodeToString(h.Sum(nil))[:24]
}

// post sends one JSON-RPC message and returns the response for id (nil for notifications).
func (c *mcpClient) post(ctx context.Context, srv models.MCPServer, auth http.Header, sessionID string, msg map[string]any) (*rpcResponse, string, error) {
	body, _ := json.Marshal(msg)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", mcpProtocolVersion)
	if sessionID != "" {
		req.Header.Set("Mcp-Session-Id", sessionID)
	}
	for k, v := range auth {
		req.Header[k] = v
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("could not reach MCP server %q: %s", srv.Name, redact(err.Error()))
	}
	defer resp.Body.Close()
	newSession := resp.Header.Get("Mcp-Session-Id")
	if resp.StatusCode == http.StatusNotFound && sessionID != "" {
		return nil, "", errSessionGone
	}
	if resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusNoContent {
		return nil, newSession, nil
	}
	if resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, "", fmt.Errorf("MCP server %q returned HTTP %d: %s", srv.Name, resp.StatusCode, truncate(strings.TrimSpace(string(snippet)), 300))
	}
	id, hasID := msg["id"]
	if !hasID {
		return nil, newSession, nil
	}
	wantID, _ := json.Marshal(id)
	limited := &capReader{r: resp.Body, remaining: c.maxBody, limit: c.maxBody}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		r, err := readSSEResponse(limited, wantID, c.maxBody)
		return r, newSession, err
	}
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, "", err
	}
	r, err := matchResponse(raw, wantID)
	return r, newSession, err
}

func matchResponse(raw []byte, wantID []byte) (*rpcResponse, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && raw[0] == '[' {
		var batch []rpcResponse
		if err := json.Unmarshal(raw, &batch); err != nil {
			return nil, fmt.Errorf("invalid MCP response: %w", err)
		}
		for i := range batch {
			if bytes.Equal(bytes.TrimSpace(batch[i].ID), wantID) {
				return &batch[i], nil
			}
		}
		return nil, errors.New("MCP response did not contain the request id")
	}
	var r rpcResponse
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("invalid MCP response: %w", err)
	}
	return &r, nil
}

// readSSEResponse scans server-sent events until the JSON-RPC response with wantID arrives.
func readSSEResponse(r io.Reader, wantID []byte, maxBody int64) (*rpcResponse, error) {
	sc := bufio.NewScanner(r)
	// A single data: line may be as large as the whole body limit; beyond that the scanner stops with
	// ErrTooLong, which is reported as errResponseTooLarge below (never a panic or silent truncation).
	sc.Buffer(make([]byte, 64*1024), int(maxBody)+1)
	var data strings.Builder
	flush := func() (*rpcResponse, bool) {
		defer data.Reset()
		if data.Len() == 0 {
			return nil, false
		}
		var resp rpcResponse
		if err := json.Unmarshal([]byte(data.String()), &resp); err != nil {
			return nil, false
		}
		if bytes.Equal(bytes.TrimSpace(resp.ID), wantID) && (resp.Result != nil || resp.Error != nil) {
			return &resp, true
		}
		return nil, false // notification or other message
	}
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if r, ok := flush(); ok {
				return r, nil
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if r, ok := flush(); ok {
		return r, nil
	}
	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return nil, errResponseTooLarge{maxBody}
		}
		return nil, err
	}
	return nil, errors.New("MCP stream ended without a response")
}

func (c *mcpClient) cachedSession(key string) *mcpSession {
	c.mu.Lock()
	defer c.mu.Unlock()
	if s := c.sessions[key]; s != nil && time.Now().Before(s.expires) {
		return s
	}
	return nil
}

// session returns a live session for this server and caller identity, initializing at most once
// even when many requests arrive together.
func (c *mcpClient) session(ctx context.Context, srv models.MCPServer, auth http.Header) (*mcpSession, error) {
	key := identityKey(srv.Name, auth)
	if s := c.cachedSession(key); s != nil {
		return s, nil
	}
	v, err := c.flight.do("init:"+key, func() (any, error) {
		if s := c.cachedSession(key); s != nil {
			return s, nil
		}
		sctx, cancel := sharedContext(ctx)
		defer cancel()
		init := map[string]any{
			"jsonrpc": "2.0",
			"id":      c.nextID.Add(1),
			"method":  "initialize",
			"params": map[string]any{
				"protocolVersion": mcpProtocolVersion,
				"capabilities":    map[string]any{},
				"clientInfo":      map[string]any{"name": "augur-grafana", "version": "1.2.0"},
			},
		}
		resp, sid, err := c.post(sctx, srv, auth, "", init)
		if err != nil {
			return nil, err
		}
		if resp == nil || resp.Error != nil {
			msg := "no response"
			if resp != nil && resp.Error != nil {
				msg = resp.Error.Message
			}
			return nil, fmt.Errorf("MCP server %q initialize failed: %s", srv.Name, msg)
		}
		if _, _, err := c.post(sctx, srv, auth, sid, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
			return nil, err
		}
		s := &mcpSession{id: sid, expires: time.Now().Add(mcpSessionTTL)}
		c.mu.Lock()
		c.sweepLocked()
		c.sessions[key] = s
		c.mu.Unlock()
		return s, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*mcpSession), nil
}

// sweepLocked evicts expired sessions and tool caches. Forwarded OAuth tokens rotate, and each new
// token is a new identity, so without eviction the maps would grow for the life of the plugin.
// The caller holds c.mu.
func (c *mcpClient) sweepLocked() {
	now := time.Now()
	if now.Sub(c.lastSweep) < mcpSweepInterval {
		return
	}
	c.lastSweep = now
	for k, s := range c.sessions {
		if now.After(s.expires) {
			delete(c.sessions, k)
		}
	}
	for k, t := range c.tools {
		if now.Sub(t.at) > mcpToolsTTL {
			delete(c.tools, k)
		}
	}
}

func (c *mcpClient) drop(srv models.MCPServer, auth http.Header) {
	c.mu.Lock()
	delete(c.sessions, identityKey(srv.Name, auth))
	c.mu.Unlock()
}

// call performs one request, re-initializing once if the session expired.
func (c *mcpClient) call(ctx context.Context, srv models.MCPServer, auth http.Header, method string, params any) (json.RawMessage, error) {
	for attempt := 0; attempt < 2; attempt++ {
		s, err := c.session(ctx, srv, auth)
		if err != nil {
			return nil, err
		}
		resp, _, err := c.post(ctx, srv, auth, s.id, map[string]any{"jsonrpc": "2.0", "id": c.nextID.Add(1), "method": method, "params": params})
		if errors.Is(err, errSessionGone) {
			c.drop(srv, auth)
			continue
		}
		if err != nil {
			return nil, err
		}
		if resp == nil {
			return nil, fmt.Errorf("MCP server %q returned no response to %s", srv.Name, method)
		}
		if resp.Error != nil {
			return nil, fmt.Errorf("MCP server %q: %s (code %d)", srv.Name, resp.Error.Message, resp.Error.Code)
		}
		return resp.Result, nil
	}
	return nil, fmt.Errorf("MCP server %q session could not be re-established", srv.Name)
}

func toolAllowed(srv models.MCPServer, name string) bool {
	if len(srv.AllowedTools) == 0 {
		return true
	}
	for _, pat := range srv.AllowedTools {
		if ok, _ := path.Match(pat, name); ok {
			return true
		}
	}
	return false
}

// listTools returns the server's tools (all pages, filtered by AllowedTools) plus a warning when the
// list was capped. Results are cached per identity (failures briefly), and concurrent requests for
// the same identity share one discovery.
func (c *mcpClient) listTools(ctx context.Context, srv models.MCPServer, auth http.Header) ([]json.RawMessage, string, error) {
	key := identityKey(srv.Name, auth)
	if e := c.cachedTools(key); e != nil {
		return e.tools, e.warning, e.err
	}
	v, _ := c.flight.do("tools:"+key, func() (any, error) {
		if e := c.cachedTools(key); e != nil {
			return e, nil
		}
		sctx, cancel := sharedContext(ctx)
		defer cancel()
		tools, warning, err := c.fetchTools(sctx, srv, auth)
		e := &toolsEntry{tools: tools, warning: warning, err: err, at: time.Now()}
		c.mu.Lock()
		c.sweepLocked()
		c.tools[key] = e
		c.mu.Unlock()
		return e, nil
	})
	e := v.(*toolsEntry)
	return e.tools, e.warning, e.err
}

func (c *mcpClient) cachedTools(key string) *toolsEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.tools[key]
	if e == nil {
		return nil
	}
	ttl := mcpToolsTTL
	if e.err != nil {
		ttl = mcpErrorTTL
	}
	if time.Since(e.at) > ttl {
		return nil
	}
	return e
}

func (c *mcpClient) fetchTools(ctx context.Context, srv models.MCPServer, auth http.Header) ([]json.RawMessage, string, error) {
	var out []json.RawMessage
	seen := map[string]bool{}
	cursor := ""
	for page := 0; ; page++ {
		if page == mcpMaxToolPages {
			return out, fmt.Sprintf("tool list truncated after %d pages (%d tools); narrow allowedTools for this server", mcpMaxToolPages, len(out)), nil
		}
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.call(ctx, srv, auth, "tools/list", params)
		if err != nil {
			return nil, "", err
		}
		var res struct {
			Tools      []json.RawMessage `json:"tools"`
			NextCursor string            `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, "", fmt.Errorf("MCP server %q: invalid tools/list result", srv.Name)
		}
		for _, t := range res.Tools {
			var meta struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(t, &meta)
			if meta.Name == "" || seen[meta.Name] || !toolAllowed(srv, meta.Name) {
				continue
			}
			if len(out) == mcpMaxTools {
				return out, fmt.Sprintf("only the first %d tools are exposed; narrow allowedTools for this server", mcpMaxTools), nil
			}
			seen[meta.Name] = true
			out = append(out, t)
		}
		if res.NextCursor == "" {
			return out, "", nil
		}
		if res.NextCursor == cursor {
			return out, "server returned the same pagination cursor twice; tool list may be incomplete", nil
		}
		cursor = res.NextCursor
	}
}

// ---- resource handlers -------------------------------------------------------

func (d *Datasource) mcpAuth(srv models.MCPServer, incoming http.Header) (http.Header, error) {
	h := http.Header{}
	token := d.settings.Secrets.MCPTokens[srv.Name]
	switch srv.Auth {
	case models.MCPAuthBearer:
		if token == "" {
			return nil, fmt.Errorf("MCP server %q: no token configured (secureJsonData mcpToken_%s)", srv.Name, srv.Name)
		}
		h.Set("Authorization", "Bearer "+token)
	case models.MCPAuthHeader:
		if token == "" {
			return nil, fmt.Errorf("MCP server %q: no token configured (secureJsonData mcpToken_%s)", srv.Name, srv.Name)
		}
		h.Set(srv.HeaderName, token)
	case models.MCPAuthOAuth:
		t, err := oauthToken(incoming, models.OAuthTokenAccess)
		if err != nil {
			return nil, err
		}
		h.Set("Authorization", "Bearer "+t)
	}
	return h, nil
}

func (d *Datasource) findMCP(name string) (models.MCPServer, bool) {
	for _, s := range d.settings.MCPServers {
		if s.Name == name {
			return s, true
		}
	}
	return models.MCPServer{}, false
}

type mcpServerTools struct {
	Name            string            `json:"name"`
	Tools           []json.RawMessage `json:"tools"`
	Error           string            `json:"error,omitempty"`
	Warning         string            `json:"warning,omitempty"`
	RequireApproval bool              `json:"requireApproval"`
}

func (d *Datasource) handleMCPTools(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	out := struct {
		Servers []mcpServerTools `json:"servers"`
	}{Servers: []mcpServerTools{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, srv := range d.settings.MCPServers {
		wg.Add(1)
		go func(srv models.MCPServer) {
			defer wg.Done()
			entry := mcpServerTools{Name: srv.Name, Tools: []json.RawMessage{}, RequireApproval: srv.NeedsApproval()}
			auth, err := d.mcpAuth(srv, r.Header)
			if err == nil {
				ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
				defer cancel()
				var tools []json.RawMessage
				tools, entry.Warning, err = d.mcp.listTools(ctx, srv, auth)
				if tools != nil {
					entry.Tools = tools
				}
				if entry.Warning != "" {
					d.logger.Warn("MCP tool list capped", "server", srv.Name, "warning", entry.Warning)
				}
			}
			if err != nil {
				entry.Error = err.Error()
				d.logger.Warn("MCP tools/list failed", "server", srv.Name, "error", err.Error())
			}
			mu.Lock()
			out.Servers = append(out.Servers, entry)
			mu.Unlock()
		}(srv)
	}
	wg.Wait()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (d *Datasource) handleMCPCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var in struct {
		Server    string          `json:"server"`
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxRequestBytes)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	srv, ok := d.findMCP(in.Server)
	if !ok {
		writeError(w, http.StatusNotFound, fmt.Sprintf("MCP server %q is not configured", in.Server))
		return
	}
	if !toolAllowed(srv, in.Tool) {
		writeError(w, http.StatusForbidden, fmt.Sprintf("tool %q is not allowed on MCP server %q", in.Tool, in.Server))
		return
	}
	auth, err := d.mcpAuth(srv, r.Header)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	args := in.Arguments
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage(`{}`)
	}
	ctx, cancel := context.WithTimeout(r.Context(), mcpCallTimeout)
	defer cancel()
	res, err := d.mcp.call(ctx, srv, auth, "tools/call", map[string]any{"name": in.Tool, "arguments": args})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	d.logger.Info("MCP tool call", "server", srv.Name, "tool", in.Tool)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(res)
}
