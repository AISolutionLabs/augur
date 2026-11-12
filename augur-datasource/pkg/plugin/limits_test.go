package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/AniAIApps/augur/augur-datasource/pkg/models"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const usageReply = `{"id":"m","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":400,"output_tokens":100,"cache_read_input_tokens":1000}}`

func errType(t *testing.T, body []byte) string {
	t.Helper()
	var e struct {
		Error struct {
			Type string `json:"type"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &e)
	return e.Error.Type
}

func limitedDS(t *testing.T, url, limits string) *Datasource {
	t.Helper()
	return newDS(t, url, `{"authMethod":"apiKey","limits":`+limits+`}`, map[string]string{"apiKey": "k"})
}

// Calling the resource API directly (as a script or a modified client would) is bound by the
// per-user daily budget: each call here costs 600 effective tokens (400 + 100 + 1000/10).
func TestDailyTokenBudgetPerUserCannotBeBypassed(t *testing.T) {
	srv, _ := upstream(t, 200, usageReply)
	ds := limitedDS(t, srv.URL, `{"tokensPerUserPerDay":1000}`)
	alice := &backend.User{Login: "alice"}
	for i, want := range []int{200, 200, 429, 429} {
		s := callMessages(t, ds, minimalBody, nil, alice)
		if s.status != want {
			t.Fatalf("call %d: status %d, want %d (%s)", i+1, s.status, want, s.body)
		}
		if want == 429 && errType(t, s.body) != "budget_exceeded" {
			t.Fatalf("call %d: error type %q", i+1, errType(t, s.body))
		}
	}
	// Another user has their own budget.
	if s := callMessages(t, ds, minimalBody, nil, &backend.User{Login: "bob"}); s.status != 200 {
		t.Fatalf("bob: %d %s", s.status, s.body)
	}
}

func TestDailyTokenBudgetForTheWholeDatasource(t *testing.T) {
	srv, _ := upstream(t, 200, usageReply)
	ds := limitedDS(t, srv.URL, `{"tokensPerDay":1000}`)
	callMessages(t, ds, minimalBody, nil, &backend.User{Login: "alice"})
	callMessages(t, ds, minimalBody, nil, &backend.User{Login: "bob"})
	if s := callMessages(t, ds, minimalBody, nil, &backend.User{Login: "carol"}); s.status != 429 || errType(t, s.body) != "budget_exceeded" {
		t.Fatalf("carol: %d %s", s.status, s.body)
	}
}

func TestRateLimitPerUser(t *testing.T) {
	srv, _ := upstream(t, 200, okReply)
	ds := limitedDS(t, srv.URL, `{"requestsPerMinutePerUser":2}`)
	u := &backend.User{Login: "alice"}
	callMessages(t, ds, minimalBody, nil, u)
	callMessages(t, ds, minimalBody, nil, u)
	s := callMessages(t, ds, minimalBody, nil, u)
	if s.status != 429 || errType(t, s.body) != "rate_limit_exceeded" {
		t.Fatalf("third call: %d %s", s.status, s.body)
	}
}

func TestConcurrencyLimitPerUser(t *testing.T) {
	block := make(chan struct{})
	entered := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-block
		_, _ = w.Write([]byte(okReply))
	}))
	t.Cleanup(srv.Close)
	ds := limitedDS(t, srv.URL, `{"maxConcurrentPerUser":1}`)
	u := &backend.User{Login: "alice"}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		callMessages(t, ds, minimalBody, nil, u)
	}()
	<-entered
	if s := callMessages(t, ds, minimalBody, nil, u); s.status != 429 || errType(t, s.body) != "concurrency_limit_exceeded" {
		t.Fatalf("second concurrent call: %d %s", s.status, s.body)
	}
	close(block)
	wg.Wait()
	// The slot is released once the call finishes.
	if s := callMessages(t, ds, minimalBody, nil, u); s.status != 200 {
		t.Fatalf("after release: %d %s", s.status, s.body)
	}
}

func TestLimiterDefaultsAndSharing(t *testing.T) {
	s, _ := models.LoadPluginSettings(backend.DataSourceInstanceSettings{URL: "http://x", DecryptedSecureJSONData: map[string]string{"apiKey": "k"}})
	if s.Limits.MaxConcurrentPerUser != models.DefaultMaxConcurrentPerUser || s.Limits.TokensPerUserPerDay != 0 {
		t.Fatalf("defaults %+v", s.Limits)
	}
	// Counters survive the instance being recreated (settings saved), keyed by datasource UID.
	mk := func() *Datasource {
		inst, err := NewDatasource(context.Background(), backend.DataSourceInstanceSettings{UID: "shared-uid", URL: "http://x", DecryptedSecureJSONData: map[string]string{"apiKey": "k"}})
		if err != nil {
			t.Fatal(err)
		}
		return inst.(*Datasource)
	}
	if mk().limiter != mk().limiter {
		t.Fatal("limiter not shared across instances of the same datasource")
	}
}

func TestBudgetResetsOnTheNextUTCDay(t *testing.T) {
	l := newUsageLimiter()
	lim := models.Limits{TokensPerUserPerDay: 100}
	day1 := time.Date(2026, 11, 12, 23, 0, 0, 0, time.UTC)
	release, err := l.admit("a", lim, day1)
	if err != nil {
		t.Fatal(err)
	}
	release()
	l.record("a", 150, day1)
	if _, err := l.admit("a", lim, day1.Add(30*time.Minute)); err == nil || err.kind != "budget_exceeded" {
		t.Fatalf("expected budget_exceeded, got %v", err)
	}
	if _, err := l.admit("a", lim, day1.Add(90*time.Minute)); err != nil {
		t.Fatalf("next day: %v", err)
	}
}

func TestEffectiveTokens(t *testing.T) {
	if got := effectiveTokens([]byte(usageReply)); got != 600 {
		t.Fatalf("got %d", got)
	}
	if got := effectiveTokens([]byte(`not json`)); got != 0 {
		t.Fatalf("got %d", got)
	}
}
