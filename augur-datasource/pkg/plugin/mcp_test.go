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
	"time"

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
	listCalls   atomic.Int32
	pages       int  // >0: serve this many pages of tools/list
	repeatPage  bool // keep returning the same cursor
	hugeCall    int  // >0: tools/call returns a single SSE data line of this many bytes
	slowInit    time.Duration
	// redefined: delete_repo is listed with a different description (the server changed it).
	redefined atomic.Bool
	// badCall: tools/call answers with a malformed JSON-RPC response of this kind.
	badCall    string
	clientInfo map[string]any
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
		time.Sleep(f.slowInit)
		var ip struct {
			ClientInfo map[string]any `json:"clientInfo"`
		}
		_ = json.Unmarshal(msg.Params, &ip)
		f.mu.Lock()
		f.clientInfo = ip.ClientInfo
		f.mu.Unlock()
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
		f.listCalls.Add(1)
		var p struct {
			Cursor string `json:"cursor"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		if f.repeatPage {
			reply(map[string]any{"tools": []any{map[string]any{"name": "t", "inputSchema": map[string]any{"type": "object"}}}, "nextCursor": "same"})
			return
		}
		if f.pages > 0 {
			n := 0
			fmt.Sscanf(p.Cursor, "%d", &n)
			tools := []any{}
			for i := 0; i < 20; i++ {
				tools = append(tools, map[string]any{"name": fmt.Sprintf("tool_%d_%d", n, i), "inputSchema": map[string]any{"type": "object"}})
			}
			next := ""
			if n+1 < f.pages {
				next = fmt.Sprint(n + 1)
			}
			reply(map[string]any{"tools": tools, "nextCursor": next})
			return
		}
		if p.Cursor == "" {
			reply(map[string]any{"tools": []any{
				map[string]any{"name": "search_runbooks", "description": "Search runbooks", "inputSchema": map[string]any{"type": "object"}, "annotations": map[string]any{"readOnlyHint": true}},
				map[string]any{"name": "delete_repo", "description": map[bool]string{false: "Dangerous", true: "Dangerous (now also deletes forks)"}[f.redefined.Load()], "inputSchema": map[string]any{"type": "object"}},
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
		switch f.badCall {
		case "wrong-id":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 999999, "result": map[string]any{"content": []any{}}})
			return
		case "no-version":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": msg.ID, "result": map[string]any{"content": []any{}}})
			return
		case "both":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{}, "error": map[string]any{"code": 1, "message": "x"}})
			return
		case "sse-wrong-version":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "data: {\"jsonrpc\":\"1.0\",\"id\":%s,\"result\":{}}\n\n", msg.ID)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if f.hugeCall > 0 {
			res, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(msg.ID), "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": strings.Repeat("x", f.hugeCall)}}}})
			fmt.Fprintf(w, "data: %s\n\n", res)
			return
		}
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
	return callResourceAs(t, ds, "Editor", method, path, body, headers)
}

func callResourceAs(t *testing.T, ds *Datasource, role, method, path, body string, headers map[string][]string) *sender {
	t.Helper()
	s := &sender{}
	req := &backend.CallResourceRequest{
		PluginContext: backend.PluginContext{User: &backend.User{Login: "u-" + role, Role: role}},
		Path:          path, URL: path, Method: method, Body: []byte(body), Headers: headers,
	}
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

func toolsResponse(t *testing.T, body []byte) (names []string, warning, errMsg string) {
	t.Helper()
	var out struct {
		Servers []struct {
			Tools   []struct{ Name string } `json:"tools"`
			Warning string                  `json:"warning"`
			Error   string                  `json:"error"`
		} `json:"servers"`
	}
	if err := json.Unmarshal(body, &out); err != nil || len(out.Servers) != 1 {
		t.Fatalf("bad response %s", body)
	}
	for _, x := range out.Servers[0].Tools {
		names = append(names, x.Name)
	}
	return names, out.Servers[0].Warning, out.Servers[0].Error
}

func TestMCPPaginationCapsAndWarns(t *testing.T) {
	f := &fakeMCP{pages: 60} // 60 pages x 20 tools
	srv := httptest.NewServer(f)
	defer srv.Close()
	ds := newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"big","url":%q}]}`, srv.URL), nil)
	names, warning, errMsg := toolsResponse(t, callResource(t, ds, http.MethodGet, "mcp/tools", "", nil).body)
	if errMsg != "" || len(names) != mcpMaxTools || !strings.Contains(warning, "first 512 tools") {
		t.Fatalf("got %d tools, warning=%q err=%q", len(names), warning, errMsg)
	}

	f2 := &fakeMCP{pages: 3}
	srv2 := httptest.NewServer(f2)
	defer srv2.Close()
	ds = newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"small","url":%q}]}`, srv2.URL), nil)
	names, warning, _ = toolsResponse(t, callResource(t, ds, http.MethodGet, "mcp/tools", "", nil).body)
	if len(names) != 60 || warning != "" {
		t.Fatalf("3 pages: %d tools warning=%q", len(names), warning)
	}

	f3 := &fakeMCP{repeatPage: true}
	srv3 := httptest.NewServer(f3)
	defer srv3.Close()
	ds = newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"loop","url":%q}]}`, srv3.URL), nil)
	_, warning, _ = toolsResponse(t, callResource(t, ds, http.MethodGet, "mcp/tools", "", nil).body)
	if !strings.Contains(warning, "same pagination cursor") || f3.listCalls.Load() != 2 {
		t.Fatalf("cursor loop: warning=%q calls=%d", warning, f3.listCalls.Load())
	}
}

func TestMCPOversizedResponseFailsClearly(t *testing.T) {
	f := &fakeMCP{hugeCall: 300_000}
	srv := httptest.NewServer(f)
	defer srv.Close()
	ds := newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"logs","url":%q}]}`, srv.URL), nil)
	ds.mcp.maxBody = 100_000 // single SSE line larger than the limit
	s := callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"logs","tool":"get_pr","arguments":{}}`, nil)
	if s.status != http.StatusBadGateway || !strings.Contains(string(s.body), "exceeds the") {
		t.Fatalf("%d %s", s.status, s.body)
	}
	// Same through the plain-JSON path.
	big := strings.Repeat("y", 200_000)
	jsonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&m)
		if m.Method == "notifications/initialized" {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "s")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"blob": big}})
	}))
	defer jsonSrv.Close()
	ds = newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"j","url":%q}]}`, jsonSrv.URL), nil)
	ds.mcp.maxBody = 100_000
	s = callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"j","tool":"x","arguments":{}}`, nil)
	if !strings.Contains(string(s.body), "exceeds the") {
		t.Fatalf("json path: %d %s", s.status, s.body)
	}
}

func TestMCPConcurrentRequestsShareInitAndDiscovery(t *testing.T) {
	f := &fakeMCP{slowInit: 100 * time.Millisecond}
	srv := httptest.NewServer(f)
	defer srv.Close()
	ds := newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"wiki","url":%q}]}`, srv.URL), nil)
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			names, _, errMsg := toolsResponse(t, callResource(t, ds, http.MethodGet, "mcp/tools", "", nil).body)
			if errMsg != "" || len(names) != 3 {
				t.Errorf("names=%v err=%s", names, errMsg)
			}
		}()
	}
	wg.Wait()
	if f.inits.Load() != 1 {
		t.Fatalf("expected 1 initialize, got %d", f.inits.Load())
	}
	if f.listCalls.Load() != 2 { // two pages, fetched once
		t.Fatalf("expected 2 tools/list calls, got %d", f.listCalls.Load())
	}
}

func TestMCPDiscoveryFailureCachedBriefly(t *testing.T) {
	f := &fakeMCP{requireAuth: "Bearer right"}
	srv := httptest.NewServer(f)
	defer srv.Close()
	ds := newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"x","url":%q,"auth":"bearer"}]}`, srv.URL), map[string]string{"mcpToken_x": "wrong"})
	for i := 0; i < 3; i++ {
		_, _, errMsg := toolsResponse(t, callResource(t, ds, http.MethodGet, "mcp/tools", "", nil).body)
		if !strings.Contains(errMsg, "401") {
			t.Fatalf("err %q", errMsg)
		}
	}
	if f.inits.Load() != 0 {
		t.Fatal("server never reached initialize")
	}
}

func TestMCPSweepEvictsExpiredSessions(t *testing.T) {
	c := newMCPClient(http.DefaultClient)
	c.sessions["old"] = &mcpSession{id: "a", expires: time.Now().Add(-time.Minute)}
	c.sessions["live"] = &mcpSession{id: "b", expires: time.Now().Add(time.Minute)}
	c.tools["stale"] = &toolsEntry{at: time.Now().Add(-time.Hour)}
	c.mu.Lock()
	c.sweepLocked()
	c.mu.Unlock()
	if _, ok := c.sessions["old"]; ok {
		t.Fatal("expired session kept")
	}
	if _, ok := c.sessions["live"]; !ok {
		t.Fatal("live session evicted")
	}
	if len(c.tools) != 0 {
		t.Fatal("stale tools cache kept")
	}
}

func TestMCPServerSideAuthorization(t *testing.T) {
	f := &fakeMCP{}
	srv := httptest.NewServer(f)
	defer srv.Close()
	// search_runbooks is annotated readOnlyHint=true by the (untrusted) server; get_pr is declared
	// read-only by the admin; delete_repo is neither.
	cfg := `{"authMethod":"none","mcpServers":[{"name":"gh","url":%q%s}]}`
	ds := newDS(t, "http://llm.example", fmt.Sprintf(cfg, srv.URL, `,"readOnlyTools":["get_*"]`), nil)

	call := func(role, tool string) *sender {
		return callResourceAs(t, ds, role, http.MethodPost, "mcp/call", fmt.Sprintf(`{"server":"gh","tool":%q,"arguments":{"q":"x"}}`, tool), nil)
	}
	if s := call("Viewer", "get_pr"); s.status != 200 {
		t.Fatalf("admin-declared read-only tool should be allowed for Viewer: %d %s", s.status, s.body)
	}
	if s := call("Viewer", "search_runbooks"); s.status != http.StatusForbidden || !strings.Contains(string(s.body), "requires the Editor role") {
		t.Fatalf("self-declared read-only hint must not be trusted by default: %d %s", s.status, s.body)
	}
	if s := call("Editor", "search_runbooks"); s.status != 200 {
		t.Fatalf("Editor may call write tools: %d %s", s.status, s.body)
	}
	if s := call("Admin", "not_listed_tool"); s.status != http.StatusForbidden || !strings.Contains(string(s.body), "not offered") {
		t.Fatalf("unlisted tools must be refused: %d %s", s.status, s.body)
	}
	if s := call("", "search_runbooks"); s.status != http.StatusForbidden {
		t.Fatalf("no role must be refused: %d", s.status)
	}

	// The listing tells the UI the effective decision.
	names := map[string]bool{}
	var out struct {
		Servers []struct {
			Tools []struct {
				Name          string `json:"name"`
				AugurReadOnly bool   `json:"augurReadOnly"`
			} `json:"tools"`
		} `json:"servers"`
	}
	_ = json.Unmarshal(callResource(t, ds, http.MethodGet, "mcp/tools", "", nil).body, &out)
	for _, tl := range out.Servers[0].Tools {
		names[tl.Name] = tl.AugurReadOnly
	}
	if !names["get_pr"] || names["search_runbooks"] || names["delete_repo"] {
		t.Fatalf("effective read-only flags wrong: %v", names)
	}

	// Trusting hints and lowering the write role are explicit admin choices.
	ds = newDS(t, "http://llm.example", fmt.Sprintf(cfg, srv.URL, `,"trustReadOnlyHints":true,"writeRole":"Admin"`), nil)
	if s := call("Viewer", "search_runbooks"); s.status != 200 {
		t.Fatalf("trusted hint: %d %s", s.status, s.body)
	}
	if s := call("Editor", "delete_repo"); s.status != http.StatusForbidden || !strings.Contains(string(s.body), "Admin role") {
		t.Fatalf("writeRole Admin: %d %s", s.status, s.body)
	}
}

func TestNoRedirectsSoKeysCannotLeak(t *testing.T) {
	var leaked atomic.Int32
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "" || r.Header.Get("X-Token") != "" || r.Header.Get("api-key") != "" {
			leaked.Add(1)
		}
		w.WriteHeader(200)
	}))
	defer attacker.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, attacker.URL+"/steal", http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	ds := newDS(t, redirector.URL, `{"authMethod":"apiKey","apiKeyHeader":"x-api-key"}`, map[string]string{"apiKey": "sk-secret"})
	s := callMessages(t, ds, minimalBody, nil, nil)
	if s.status != http.StatusTemporaryRedirect {
		t.Fatalf("model call should surface the redirect, got %d", s.status)
	}
	ds = newDS(t, "http://llm.example", fmt.Sprintf(`{"authMethod":"none","mcpServers":[{"name":"x","url":%q,"auth":"header","headerName":"X-Token"}]}`, redirector.URL), map[string]string{"mcpToken_x": "mcp-secret"})
	callResource(t, ds, http.MethodGet, "mcp/tools", "", nil)
	if leaked.Load() != 0 {
		t.Fatalf("credentials were sent to the redirect target %d time(s)", leaked.Load())
	}
}

func TestMCPResponsesAreValidatedForEveryTransport(t *testing.T) {
	for _, bad := range []string{"wrong-id", "no-version", "both", "sse-wrong-version"} {
		t.Run(bad, func(t *testing.T) {
			f := &fakeMCP{badCall: bad}
			srv := httptest.NewServer(f)
			t.Cleanup(srv.Close)
			ds := newDS(t, "http://model", `{"authMethod":"apiKey","mcpServers":[{"name":"gh","url":"`+srv.URL+`","readOnlyTools":["search_*"]}]}`, map[string]string{"apiKey": "k"})
			s := callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"gh","tool":"search_runbooks","arguments":{}}`, nil)
			if s.status != http.StatusBadGateway || !strings.Contains(string(s.body), "invalid MCP response") {
				t.Fatalf("%s: status %d body %s", bad, s.status, s.body)
			}
		})
	}
}

func TestMCPToolRedefinitionIsRefused(t *testing.T) {
	f := &fakeMCP{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	ds := newDS(t, "http://model", `{"authMethod":"apiKey","mcpServers":[{"name":"gh","url":"`+srv.URL+`"}]}`, map[string]string{"apiKey": "k"})
	list := callResource(t, ds, http.MethodGet, "mcp/tools", "", nil)
	var out struct {
		Servers []struct {
			Tools []map[string]any `json:"tools"`
		} `json:"servers"`
	}
	_ = json.Unmarshal(list.body, &out)
	fp := ""
	for _, tl := range out.Servers[0].Tools {
		if tl["name"] == "delete_repo" {
			fp, _ = tl["augurFingerprint"].(string)
		}
	}
	if !strings.HasPrefix(fp, "sha256:") {
		t.Fatalf("no fingerprint in listing: %s", list.body)
	}
	call := `{"server":"gh","tool":"delete_repo","arguments":{},"fingerprint":"` + fp + `"}`
	if s := callResource(t, ds, http.MethodPost, "mcp/call", call, nil); s.status != 200 {
		t.Fatalf("unchanged definition: %d %s", s.status, s.body)
	}
	// The server redefines the tool. Once the call-time catalog refreshes, the old fingerprint is refused.
	f.redefined.Store(true)
	ds.mcp.invalidateTools(ds.settings.MCPServers[0], http.Header{})
	s := callResource(t, ds, http.MethodPost, "mcp/call", call, nil)
	if s.status != http.StatusConflict || errType(t, s.body) != "tool_changed" {
		t.Fatalf("redefined: %d %s", s.status, s.body)
	}
	if n := len(f.calls); n != 1 {
		t.Fatalf("the redefined tool must not run; calls=%v", f.calls)
	}
}

func TestMCPCallAuthorizationUsesAFreshCatalog(t *testing.T) {
	f := &fakeMCP{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	ds := newDS(t, "http://model", `{"authMethod":"apiKey","mcpServers":[{"name":"gh","url":"`+srv.URL+`"}]}`, map[string]string{"apiKey": "k"})
	callResource(t, ds, http.MethodGet, "mcp/tools", "", nil)
	before := f.listCalls.Load()
	// Age the cached catalog past the call-time bound (but within the listing TTL).
	ds.mcp.mu.Lock()
	for _, e := range ds.mcp.tools {
		e.at = time.Now().Add(-2 * mcpCallToolsMaxAge)
	}
	ds.mcp.mu.Unlock()
	callResource(t, ds, http.MethodPost, "mcp/call", `{"server":"gh","tool":"delete_repo","arguments":{}}`, nil)
	if f.listCalls.Load() == before {
		t.Fatal("the call was authorized against a catalog older than mcpCallToolsMaxAge")
	}
}

func TestMCPClientReportsPluginVersion(t *testing.T) {
	f := &fakeMCP{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	ds := newDS(t, "http://model", `{"authMethod":"apiKey","mcpServers":[{"name":"gh","url":"`+srv.URL+`"}]}`, map[string]string{"apiKey": "k"})
	s := &sender{}
	pc := backend.PluginContext{PluginVersion: "1.7.0", User: &backend.User{Login: "u", Role: "Editor"}}
	req := &backend.CallResourceRequest{PluginContext: pc, Path: "mcp/tools", URL: "mcp/tools", Method: http.MethodGet}
	if err := ds.CallResource(backend.WithPluginContext(context.Background(), pc), req, s); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.clientInfo["name"] != "augur-grafana" || f.clientInfo["version"] != "1.7.0" {
		t.Fatalf("clientInfo %v", f.clientInfo)
	}
}
