package plugin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// modelsUpstream serves a model list at /v1/models (paged like Anthropic when anthropicPages is
// true) and a minimal Messages reply at /v1/messages.
func modelsUpstream(t *testing.T, anthropicPages bool, byToken map[string][]string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var listCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			listCalls.Add(1)
			ids := byToken[r.Header.Get("Authorization")]
			if ids == nil {
				ids = byToken[""]
			}
			if !anthropicPages {
				data := []map[string]string{}
				for _, id := range ids {
					data = append(data, map[string]string{"id": id, "object": "model"})
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "object": "list"})
				return
			}
			// two pages: first half, then the rest via after_id
			half := len(ids) / 2
			page, more := ids[:half], true
			if r.URL.Query().Get("after_id") != "" {
				page, more = ids[half:], false
			}
			data := []map[string]string{}
			for _, id := range page {
				data = append(data, map[string]string{"id": id, "display_name": strings.ToUpper(id)})
			}
			last := ""
			if len(page) > 0 {
				last = page[len(page)-1]
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "has_more": more, "last_id": last})
		case "/v1/messages":
			_, _ = w.Write([]byte(`{"id":"m","type":"message","role":"assistant","content":[],"stop_reason":"end_turn"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &listCalls
}

func getConfig(t *testing.T, ds *Datasource, headers map[string][]string) publicConfig {
	t.Helper()
	s := callResource(t, ds, "GET", "/config", "", headers)
	var c publicConfig
	if err := json.Unmarshal(s.body, &c); err != nil {
		t.Fatalf("config: %v %s", err, s.body)
	}
	return c
}

func TestModelsDiscoveredFromEndpointWithPagingAndFilters(t *testing.T) {
	srv, calls := modelsUpstream(t, true, map[string][]string{"": {"claude-opus-5-5", "claude-sonnet-5-5", "text-embedding-3", "claude-haiku-5-5", "gpt-x"}})
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","defaultModel":"claude-sonnet-5-5","allowedModels":["claude-*"]}`, map[string]string{"apiKey": "k"})

	c := getConfig(t, ds, nil)
	if strings.Join(c.Models, ",") != "claude-sonnet-5-5,claude-opus-5-5,claude-haiku-5-5" {
		t.Fatalf("models = %v (default first, glob-filtered, embeddings dropped, both pages read)", c.Models)
	}
	if c.ModelSource != "endpoint" || c.ModelNames["claude-opus-5-5"] != "CLAUDE-OPUS-5-5" || c.ModelWarning != "" {
		t.Fatalf("unexpected config: %+v", c)
	}
	getConfig(t, ds, nil)
	if calls.Load() != 2 { // two pages once, then cached
		t.Fatalf("expected the list to be fetched once (2 pages), got %d calls", calls.Load())
	}

	// Discovered models are allowed; others (and filtered-out ones) are rejected.
	if s := callMessages(t, ds, `{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"x"}]}`, nil, nil); s.status != 200 {
		t.Fatalf("discovered model rejected: %d %s", s.status, s.body)
	}
	for _, m := range []string{"gpt-x", "claude-unknown"} {
		if s := callMessages(t, ds, `{"model":"`+m+`","messages":[{"role":"user","content":"x"}]}`, nil, nil); s.status != 400 {
			t.Fatalf("%s should be rejected, got %d", m, s.status)
		}
	}
}

func TestModelsPerOAuthUser(t *testing.T) {
	srv, _ := modelsUpstream(t, false, map[string][]string{
		"Bearer alice": {"claude-sonnet-5-5", "claude-opus-5-5"},
		"Bearer bob":   {"claude-sonnet-5-5"},
	})
	ds := newDS(t, srv.URL, `{"authMethod":"oauth","oauthPassThru":true,"apiFormat":"anthropic","defaultModel":"claude-sonnet-5-5"}`, nil)
	alice := map[string][]string{"Authorization": {"Bearer alice"}}
	bob := map[string][]string{"Authorization": {"Bearer bob"}}
	if got := getConfig(t, ds, alice).Models; len(got) != 2 {
		t.Fatalf("alice models = %v", got)
	}
	if got := getConfig(t, ds, bob).Models; len(got) != 1 {
		t.Fatalf("bob models = %v (must not see alice's cached list)", got)
	}
	if s := callMessages(t, ds, `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"x"}]}`, bob, nil); s.status != 400 {
		t.Fatalf("bob must not use opus, got %d", s.status)
	}
}

func TestModelsFallBackToConfiguredList(t *testing.T) {
	srv, _ := upstream(t, http.StatusNotFound, `{"error":"no"}`)
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","defaultModel":"claude-sonnet-5-5","allowedModels":["claude-opus-5-5","claude-*"]}`, map[string]string{"apiKey": "k"})
	c := getConfig(t, ds, nil)
	if strings.Join(c.Models, ",") != "claude-sonnet-5-5,claude-opus-5-5" || c.ModelSource != "config" || !strings.Contains(c.ModelWarning, "HTTP 404") {
		t.Fatalf("fallback config = %+v", c)
	}
}

func TestModelDiscoveryOffUsesConfiguredList(t *testing.T) {
	srv, calls := modelsUpstream(t, false, map[string][]string{"": {"claude-opus-5-5"}})
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","modelDiscovery":"off","defaultModel":"a","allowedModels":["b","claude-*"]}`, map[string]string{"apiKey": "k"})
	c := getConfig(t, ds, nil)
	if strings.Join(c.Models, ",") != "a,b" || c.ModelSource != "config" || calls.Load() != 0 {
		t.Fatalf("discovery off: %+v calls=%d", c, calls.Load())
	}
	// globs still allow matching names to be requested
	if s := callMessages(t, ds, `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"x"}]}`, nil, nil); s.status != 200 {
		t.Fatalf("glob-allowed model rejected: %d", s.status)
	}
}

func TestDefaultModelMissingFromListIsKeptWithWarning(t *testing.T) {
	srv, _ := modelsUpstream(t, false, map[string][]string{"": {"claude-opus-5-5"}})
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","defaultModel":"team-alias"}`, map[string]string{"apiKey": "k"})
	c := getConfig(t, ds, nil)
	if strings.Join(c.Models, ",") != "team-alias,claude-opus-5-5" || !strings.Contains(c.ModelWarning, "team-alias") {
		t.Fatalf("config = %+v", c)
	}
}
