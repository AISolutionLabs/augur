package plugin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"

	"github.com/AniAIApps/augur/augur-datasource/pkg/models"
)

// Model discovery: the models offered in the chat come from the endpoint's own list (Anthropic
// /v1/models, LiteLLM or OpenAI-compatible /v1/models), fetched with the caller's credentials, so
// a LiteLLM key or a user's OAuth token only sees the models it may use. The admin's allowed
// names/globs filter that list. If the endpoint cannot list models, the configured list is used.

const (
	modelListTTL      = 5 * time.Minute
	modelListErrorTTL = 30 * time.Second
	maxModelPages     = 10
	maxModelListBytes = 2 << 20
)

// Ids that are clearly not chat models (LiteLLM and OpenAI-compatible gateways list everything).
var nonChatModel = regexp.MustCompile(`(?i)(embed|whisper|tts|dall-e|moderation|rerank|transcri|speech|image-gen|text-to-image)`)

type modelInfo struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type modelListing struct {
	models  []modelInfo // after filtering, default first
	source  string      // "endpoint" or "config"
	warning string
	at      time.Time
	ttl     time.Duration
}

type modelCache struct {
	mu      sync.Mutex
	entries map[string]*modelListing
	flight  flightGroup
}

// modelIdentity separates cache entries per credential: with OAuth the list depends on the user.
func (d *Datasource) modelIdentity(incoming http.Header) string {
	if d.settings.AuthMethod != models.AuthMethodOAuth {
		return "static"
	}
	h := sha256.New()
	h.Write([]byte(incoming.Get("Authorization")))
	h.Write([]byte{0})
	h.Write([]byte(incoming.Get("X-Id-Token")))
	return hex.EncodeToString(h.Sum(nil))
}

func (d *Datasource) configuredListing(warning string) *modelListing {
	out := []modelInfo{}
	for _, m := range d.settings.Models() {
		out = append(out, modelInfo{ID: m})
	}
	return &modelListing{models: out, source: "config", warning: warning}
}

// availableModels returns the models this caller may use (default first). Cached per identity.
func (d *Datasource) availableModels(ctx context.Context, incoming http.Header) *modelListing {
	if d.settings.ModelDiscovery == models.ModelDiscoveryOff {
		return d.configuredListing("")
	}
	key := d.modelIdentity(incoming)
	d.models.mu.Lock()
	if d.models.entries == nil {
		d.models.entries = map[string]*modelListing{}
	}
	if e, ok := d.models.entries[key]; ok && time.Since(e.at) < e.ttl {
		d.models.mu.Unlock()
		return e
	}
	d.models.mu.Unlock()

	v, _ := d.models.flight.do(key, func() (any, error) {
		// Shared by concurrent callers, so not tied to the first caller's cancellation.
		listing := d.discoverModels(context.WithoutCancel(ctx), incoming)
		d.models.mu.Lock()
		defer d.models.mu.Unlock()
		for k, e := range d.models.entries { // keep the cache bounded (OAuth: one entry per user token)
			if time.Since(e.at) >= e.ttl {
				delete(d.models.entries, k)
			}
		}
		d.models.entries[key] = listing
		return listing, nil
	})
	return v.(*modelListing)
}

func (d *Datasource) discoverModels(ctx context.Context, incoming http.Header) *modelListing {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ids, err := d.fetchModelIDs(ctx, incoming)
	if err != nil {
		d.logger.Warn("Could not list models; using the configured list", "error", err.Error())
		l := d.configuredListing("Could not list models from the endpoint (" + truncate(err.Error(), 200) + "); showing the configured models.")
		l.at, l.ttl = time.Now(), modelListErrorTTL
		return l
	}
	out := []modelInfo{}
	seen := map[string]bool{}
	var hasDefault bool
	for _, m := range ids {
		if seen[m.ID] || nonChatModel.MatchString(m.ID) || !d.settings.MatchesAllowed(m.ID) {
			continue
		}
		seen[m.ID] = true
		if m.ID == d.settings.DefaultModel {
			hasDefault = true
			out = append([]modelInfo{m}, out...)
			continue
		}
		out = append(out, m)
	}
	warning := ""
	if !hasDefault {
		// The default stays usable (it may be an alias the endpoint does not list), but say so.
		out = append([]modelInfo{{ID: d.settings.DefaultModel}}, out...)
		warning = fmt.Sprintf("The default model %q is not in the endpoint's model list.", d.settings.DefaultModel)
	}
	return &modelListing{models: out, source: "endpoint", warning: warning, at: time.Now(), ttl: modelListTTL}
}

// fetchModelIDs reads every page of the endpoint's model list. It accepts the Anthropic shape
// ({data:[{id,display_name}], has_more, last_id}) and the OpenAI/LiteLLM shape ({data:[{id}]}).
func (d *Datasource) fetchModelIDs(ctx context.Context, incoming http.Header) ([]modelInfo, error) {
	var all []modelInfo
	after := ""
	for page := 0; page < maxModelPages; page++ {
		p := d.settings.ModelsPath
		if d.settings.APIFormat != models.APIFormatOpenAI {
			q := url.Values{"limit": {"1000"}}
			if after != "" {
				q.Set("after_id", after)
			}
			p += "?" + q.Encode()
		}
		req, err := d.newUpstreamRequest(ctx, http.MethodGet, p, nil, incoming)
		if err != nil {
			return nil, err
		}
		resp, err := d.client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("could not reach endpoint: %s", redact(err.Error()))
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxModelListBytes))
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, d.settings.ModelsPath)
		}
		var parsed struct {
			Data []struct {
				ID          string `json:"id"`
				DisplayName string `json:"display_name"`
			} `json:"data"`
			HasMore bool   `json:"has_more"`
			LastID  string `json:"last_id"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil || parsed.Data == nil {
			return nil, fmt.Errorf("unexpected response from %s (not a model list)", d.settings.ModelsPath)
		}
		for _, m := range parsed.Data {
			if m.ID != "" {
				all = append(all, modelInfo{ID: m.ID, Name: m.DisplayName})
			}
		}
		if !parsed.HasMore || parsed.LastID == "" || parsed.LastID == after {
			return all, nil
		}
		after = parsed.LastID
	}
	return all, nil
}

// modelAllowed checks a requested model against what this caller is offered.
func (d *Datasource) modelAllowed(ctx context.Context, incoming http.Header, model string) bool {
	if model == d.settings.DefaultModel {
		return true
	}
	l := d.availableModels(ctx, incoming)
	if l.source == "config" && d.settings.IsModelAllowed(model) { // names and patterns from the config
		return true
	}
	for _, m := range l.models {
		if m.ID == model {
			return true
		}
	}
	return false
}

// handleModels lists the models this caller may use (for the chat picker and the config editor).
func (d *Datasource) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if r.URL.Query().Get("refresh") == "1" {
		d.models.mu.Lock()
		delete(d.models.entries, d.modelIdentity(r.Header))
		d.models.mu.Unlock()
	}
	l := d.availableModels(r.Context(), r.Header)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"defaultModel": d.settings.DefaultModel,
		"models":       l.models,
		"source":       l.source,
		"warning":      l.warning,
	})
}
