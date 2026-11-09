package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// fakeMCP is a streamable-HTTP MCP server: JSON for initialize/tools/list, SSE for tools/call.
type fakeMCP struct {
	mu          sync.Mutex
	sessions    map[string]bool
	inits       atomic.Int32
	expireNext  atomic.Bool
	lastAuth    string
	calls       []string
	requireAuth string
}

func (f *fakeMCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.lastAuth = r.Header.Get("Authorization")
	f.mu.Unlock()
	if f.requireAuth != "" && r.Header.Get("Authorization") != f.requireAuth {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	b, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(b, &msg)
	sid := r.Header.Get("Mcp-Session-Id")
	reply := func(result any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
	}
	switch msg.Method {
	case "initialize":
		n := f.inits.Add(1)
		id := fmt.Sprintf("sess-%d", n)
		f.mu.Lock()
		if f.sessions == nil {
			f.sessions = map[string]bool{}
		}
		f.sessions[id] = true
		f.mu.Unlock()
		w.Header().Set("Mcp-Session-Id", id)
		reply(map[string]any{"protocolVersion": mcpProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "fake"}})
		return
	case "notifications/initialized":
		w.WriteHeader(http.StatusAccepted)
		return
	}
	f.mu.Lock()
	ok := f.sessions[sid]
	f.mu.Unlock()
	if !ok || f.expireNext.CompareAndSwap(true, false) {
		f.mu.Lock()
		delete(f.sessions, sid)
		f.mu.Unlock()
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	switch msg.Method {
	case "tools/list":
		var p struct {
			Cursor string `json:"cursor"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		if p.Cursor == "" {
			reply(map[string]any{"tools": []any{
				map[string]any{"name": "search_runbooks", "description": "Search runbooks", "inputSchema": map[string]any{"type": "object"}, "annotations": map[string]any{"readOnlyHint": true}},
				map[string]any{"name": "delete_repo", "description": "Dangerous", "inputSchema": map[string]any{"type": "object"}},
			}, "nextCursor": "p2"})
			return
		}
		reply(map[string]any{"tools": []any{map[string]any{"name": "get_pr", "description": "Get PR", "inputSchema": map[string]any{"type": "object"}}}})
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		f.mu.Lock()
		f.calls = append(f.calls, p.Name)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		// A progress notification first, then the response, split across data lines.
		fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\n\n")
		res, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(msg.ID), "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("ran %s with %v", p.Name, p.Arguments["q"])}}}})
		fmt.Fprintf(w, "event: message\ndata: %s\n\n", res)
	default:
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32601, "message": "method not found"}})
	}
}

func callResource(t *testing.T, ds *Datasource, method, path, body string, headers map[string][]string) *sender {
	t.Helper()
	s := &sender{}
	req := &backend.CallResourceRequest{Path: path, URL: path, Method: method, Body: []byte(body), Headers: headers}
	if err := ds.CallResource(context.Background(), req, s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestMCPListAndCallWithBearer(t *testing.T) {
	f := &fakeMCP{requireAuth: "Bearer gh-token"}
	srv := httptest.NewServer(f)
	defer srv.Close()
	ds := newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"github","url":%q,"auth":"bearer","allowedTools":["search_*","get_*"]}]}`, srv.URL), map[string]string{"mcpToken_github": "gh-token"})

	s := callResource(t, ds, http.MethodGet, "mcp/tools", "", nil)
	var out struct {
		Servers []struct {
			Name            string            `json:"name"`
			Tools           []json.RawMessage `json:"tools"`
			Error           string            `json:"error"`
			RequireApproval bool              `json:"requireApproval"`
		} `json:"servers"`
	}
	if err := json.Unmarshal(s.body, &out); err != nil {
		t.Fatalf("%v %s", err, s.body)
	}
	if len(out.Servers) != 1 || out.Servers[0].Error != "" {
		t.Fatalf("servers %+v", out.Servers)
	}
	names := []string{}
	for _, raw := range out.Servers[0].Tools {
		var x struct{ Name string }
		_ = json.Unmarshal(raw, &x)
		names = append(names, x.Name)
	}
	if strings.Join(names, ",") != "search_runbooks,get_pr" { // paginated, delete_repo filtered out
		t.Fatalf("tools %v", names)
	}
	if !out.Servers[0].RequireApproval {
		t.Fatal("approval should default to required")
	}

	s = callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"github","tool":"search_runbooks","arguments":{"q":"kafka"}}`, nil)
	if s.status != 200 || !strings.Contains(string(s.body), "ran search_runbooks with kafka") {
		t.Fatalf("call %d %s", s.status, s.body)
	}
	if f.inits.Load() != 1 {
		t.Fatalf("session should be reused, inits=%d", f.inits.Load())
	}

	s = callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"github","tool":"delete_repo","arguments":{}}`, nil)
	if s.status != http.StatusForbidden {
		t.Fatalf("disallowed tool: %d", s.status)
	}
}

func TestMCPSessionExpiryReinitializes(t *testing.T) {
	f := &fakeMCP{}
	srv := httptest.NewServer(f)
	defer srv.Close()
	ds := newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"docs","url":%q}]}`, srv.URL), nil)
	callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"docs","tool":"search_runbooks","arguments":{"q":1}}`, nil)
	f.expireNext.Store(true)
	s := callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"docs","tool":"search_runbooks","arguments":{"q":2}}`, nil)
	if s.status != 200 || !strings.Contains(string(s.body), "with 2") {
		t.Fatalf("after expiry: %d %s", s.status, s.body)
	}
	if f.inits.Load() != 2 {
		t.Fatalf("expected re-initialize, inits=%d", f.inits.Load())
	}
}

func TestMCPOAuthForwardingAndErrors(t *testing.T) {
	f := &fakeMCP{}
	srv := httptest.NewServer(f)
	defer srv.Close()
	ds := newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"oauth","oauthPassThru":true,"mcpServers":[{"name":"ado","url":%q,"auth":"oauth"}]}`, srv.URL), nil)

	s := callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"ado","tool":"x","arguments":{}}`, nil)
	if s.status != http.StatusUnauthorized {
		t.Fatalf("no token: %d", s.status)
	}
	s = callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"ado","tool":"get_pr","arguments":{}}`, map[string][]string{backend.OAuthIdentityTokenHeaderName: {"Bearer user-entra"}})
	if s.status != 200 || f.lastAuth != "Bearer user-entra" {
		t.Fatalf("oauth: %d auth=%q %s", s.status, f.lastAuth, s.body)
	}
	s = callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"nope","tool":"x"}`, nil)
	if s.status != http.StatusNotFound {
		t.Fatalf("unknown server: %d", s.status)
	}
}

func TestMCPUnreachableServerReportedPerServer(t *testing.T) {
	ds := newDS(t, "http://llm.example", `{"authMethod":"none","mcpServers":[{"name":"dead","url":"http://127.0.0.1:1"}]}`, nil)
	s := callResource(t, ds, http.MethodGet, "mcp/tools", "", nil)
	if !strings.Contains(string(s.body), `"error"`) || !strings.Contains(string(s.body), "dead") {
		t.Fatalf("%s", s.body)
	}
}

func TestMCPConfigValidation(t *testing.T) {
	ds := newDS(t, "http://llm.example", `{"authMethod":"none","mcpServers":[{"name":"x","url":"http://a","auth":"oauth"}]}`, nil)
	if err := ds.settings.Validate(); err == nil || !strings.Contains(err.Error(), "Forward OAuth") {
		t.Fatalf("expected oauth validation error, got %v", err)
	}
	ds = newDS(t, "http://llm.example", `{"authMethod":"none","mcpServers":[{"name":"x","url":"ftp://a"}]}`, nil)
	if err := ds.settings.Validate(); err == nil {
		t.Fatal("expected URL validation error")
	}
}
