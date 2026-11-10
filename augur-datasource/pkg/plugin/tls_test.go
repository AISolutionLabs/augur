package plugin

import (
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// A gateway with a certificate from a private CA (like an internal LiteLLM).
func privateTLSGateway(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-sonnet-5-5"}]}`))
	}))
	t.Cleanup(srv.Close)
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	return srv, string(ca)
}

func health(t *testing.T, ds *Datasource) *backend.CheckHealthResult {
	t.Helper()
	r, err := ds.CheckHealth(t.Context(), &backend.CheckHealthRequest{})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestPrivateCAWithoutConfigFails(t *testing.T) {
	srv, _ := privateTLSGateway(t)
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey"}`, map[string]string{"apiKey": "k"})
	if r := health(t, ds); r.Status != backend.HealthStatusError || !strings.Contains(r.Message, "certificate") {
		t.Fatalf("expected a certificate error, got %v %q", r.Status, r.Message)
	}
}

func TestInlineCACertificate(t *testing.T) {
	srv, ca := privateTLSGateway(t)
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","tlsAuthWithCACert":true}`, map[string]string{"apiKey": "k", "tlsCACert": ca})
	if r := health(t, ds); r.Status != backend.HealthStatusOk {
		t.Fatalf("health with inline CA: %v %q", r.Status, r.Message)
	}
	// The private CA is added to the system roots, not substituted for them.
	pool, err := rootCAs(ca, "")
	if err != nil || pool == nil || len(pool.Subjects()) < 2 { //nolint:staticcheck // Subjects is fine for a count in tests
		t.Fatalf("expected system roots plus the CA, got %v %v", pool, err)
	}
}

func TestCACertificateFile(t *testing.T) {
	srv, ca := privateTLSGateway(t)
	file := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(file, []byte(ca), 0o600); err != nil {
		t.Fatal(err)
	}
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","tlsCACertFile":"`+file+`"}`, map[string]string{"apiKey": "k"})
	if r := health(t, ds); r.Status != backend.HealthStatusOk {
		t.Fatalf("health with CA file: %v %q", r.Status, r.Message)
	}
	if s := callResource(t, ds, "GET", "/config", "", nil); s.status != 200 || !strings.Contains(string(s.body), `"modelSource":"endpoint"`) {
		t.Fatalf("model discovery over private TLS: %d %s", s.status, s.body)
	}
}

func TestBadCAIsReportedByHealth(t *testing.T) {
	srv, _ := privateTLSGateway(t)
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","tlsCACertFile":"/nonexistent/ca.pem"}`, map[string]string{"apiKey": "k"})
	if r := health(t, ds); r.Status != backend.HealthStatusError || !strings.Contains(r.Message, "CA certificate: could not read CA file") {
		t.Fatalf("got %v %q", r.Status, r.Message)
	}
	ds2 := newDS(t, srv.URL, `{"authMethod":"apiKey","tlsAuthWithCACert":true}`, map[string]string{"apiKey": "k", "tlsCACert": "not pem"})
	if r := health(t, ds2); !strings.Contains(r.Message, "not valid PEM") {
		t.Fatalf("got %q", r.Message)
	}
}
