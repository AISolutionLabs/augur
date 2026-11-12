package plugin

import (
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/AniAIApps/augur/augur-datasource/pkg/models"
)

// usageLimiter enforces models.Limits for one datasource. Instances are shared by datasource UID,
// so counters survive the instance being recreated when its settings are saved. State is in
// memory: with several Grafana replicas each enforces its own share, and counters reset on restart.
type usageLimiter struct {
	mu       sync.Mutex
	inflight map[string]int
	recent   map[string][]time.Time
	day      string
	perUser  map[string]int64
	total    int64
}

var limiters sync.Map // datasource UID -> *usageLimiter

func newUsageLimiter() *usageLimiter {
	return &usageLimiter{inflight: map[string]int{}, recent: map[string][]time.Time{}, perUser: map[string]int64{}}
}

// limiterFor returns the shared limiter for a datasource (a private one if the UID is unknown).
func limiterFor(uid string) *usageLimiter {
	if uid == "" {
		return newUsageLimiter()
	}
	l, _ := limiters.LoadOrStore(uid, newUsageLimiter())
	return l.(*usageLimiter)
}

// limitError is returned when a call is refused. Retryable errors (rate, concurrency) clear on
// their own; budget errors last until the next UTC day.
type limitError struct {
	kind       string // rate_limit_exceeded | concurrency_limit_exceeded | budget_exceeded
	message    string
	retryAfter time.Duration
}

func (e *limitError) Error() string { return e.message }

func (l *usageLimiter) rollDay(now time.Time) {
	if d := now.UTC().Format("2006-01-02"); d != l.day {
		l.day = d
		l.perUser = map[string]int64{}
		l.total = 0
	}
}

// admit reserves a slot for one model call, or explains why it is refused. The returned release
// must be called when the call ends.
func (l *usageLimiter) admit(user string, lim models.Limits, now time.Time) (func(), *limitError) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollDay(now)
	if lim.TokensPerDay > 0 && l.total >= lim.TokensPerDay {
		return nil, &limitError{kind: "budget_exceeded", message: fmt.Sprintf("this datasource's daily token budget (%s) is used up; it resets at 00:00 UTC", humanTokens(lim.TokensPerDay))}
	}
	if lim.TokensPerUserPerDay > 0 && l.perUser[user] >= lim.TokensPerUserPerDay {
		return nil, &limitError{kind: "budget_exceeded", message: fmt.Sprintf("your daily token budget on this datasource (%s) is used up; it resets at 00:00 UTC", humanTokens(lim.TokensPerUserPerDay))}
	}
	if lim.RequestsPerMinutePerUser > 0 {
		window := now.Add(-time.Minute)
		kept := l.recent[user][:0]
		for _, t := range l.recent[user] {
			if t.After(window) {
				kept = append(kept, t)
			}
		}
		l.recent[user] = kept
		if len(kept) >= lim.RequestsPerMinutePerUser {
			wait := kept[0].Add(time.Minute).Sub(now)
			return nil, &limitError{kind: "rate_limit_exceeded", message: fmt.Sprintf("rate limit: %d model calls per minute per user", lim.RequestsPerMinutePerUser), retryAfter: wait}
		}
		l.recent[user] = append(l.recent[user], now)
	}
	if lim.MaxConcurrentPerUser > 0 && l.inflight[user] >= lim.MaxConcurrentPerUser {
		return nil, &limitError{kind: "concurrency_limit_exceeded", message: fmt.Sprintf("too many model calls in progress (limit %d per user)", lim.MaxConcurrentPerUser), retryAfter: 2 * time.Second}
	}
	l.inflight[user]++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			if l.inflight[user]--; l.inflight[user] <= 0 {
				delete(l.inflight, user)
			}
		})
	}, nil
}

// record adds a finished call's token use to the daily counters.
func (l *usageLimiter) record(user string, tokens int64, now time.Time) {
	if tokens <= 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollDay(now)
	l.perUser[user] += tokens
	l.total += tokens
}

// effectiveTokens reads usage from a Messages-format response body: input + output + cache writes,
// cache reads weighted 10% (they cost about a tenth of fresh input).
func effectiveTokens(body []byte) int64 {
	var r struct {
		Usage struct {
			Input      int64 `json:"input_tokens"`
			Output     int64 `json:"output_tokens"`
			CacheWrite int64 `json:"cache_creation_input_tokens"`
			CacheRead  int64 `json:"cache_read_input_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(body, &r) != nil {
		return 0
	}
	u := r.Usage
	return u.Input + u.Output + u.CacheWrite + u.CacheRead/10
}

func humanTokens(n int64) string {
	switch {
	case n >= 1_000_000:
		return strconv.FormatFloat(float64(n)/1e6, 'f', -1, 64) + "M tokens"
	case n >= 1_000:
		return strconv.FormatFloat(float64(n)/1e3, 'f', -1, 64) + "k tokens"
	}
	return strconv.FormatInt(n, 10) + " tokens"
}
