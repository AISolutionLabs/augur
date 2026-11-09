package plugin

import (
	"encoding/json"
	"strings"
	"testing"
)

const anthRequest = `{
 "system":[{"type":"text","text":"You are Augur.","cache_control":{"type":"ephemeral"}}],
 "messages":[
  {"role":"user","content":[{"type":"text","text":"why slow?"}]},
  {"role":"assistant","content":[{"type":"text","text":"Checking."},{"type":"tool_use","id":"tu_1","name":"query_prometheus","input":{"expr":"up"}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"3 series","is_error":false},{"type":"tool_result","tool_use_id":"tu_2","content":[{"type":"text","text":"boom"}],"is_error":true},{"type":"text","text":"budget note"}]}
 ],
 "tools":[{"name":"query_prometheus","description":"PromQL","input_schema":{"type":"object","properties":{"expr":{"type":"string"}}},"cache_control":{"type":"ephemeral"}}],
 "tool_choice":{"type":"none"}
}`

func TestToOpenAITranslatesConversationAndTools(t *testing.T) {
	var in messagesRequest
	if err := json.Unmarshal([]byte(anthRequest), &in); err != nil {
		t.Fatal(err)
	}
	body := upstreamBody{Model: "gpt-x", System: in.System, Messages: in.Messages, Tools: in.Tools, ToolChoice: in.ToolChoice, MaxTokens: 1000, Metadata: map[string]string{"user_id": "alice"}}
	out, err := toOpenAI(body, "max_completion_tokens")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(out)
	s := string(b)
	for _, want := range []string{
		`"role":"system","content":"You are Augur."`,
		`"role":"assistant","content":"Checking.","tool_calls":[{"id":"tu_1","type":"function","function":{"name":"query_prometheus","arguments":"{\"expr\":\"up\"}"}}]`,
		`"role":"tool","content":"3 series","tool_call_id":"tu_1"`,
		`"role":"tool","content":"ERROR: boom","tool_call_id":"tu_2"`,
		`"role":"user","content":"budget note"`,
		`"tool_choice":"none"`,
		`"max_completion_tokens":1000`,
		`"user":"alice"`,
		`"parameters":{"type":"object"`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %s in\n%s", want, s)
		}
	}
	if strings.Contains(s, "cache_control") || strings.Contains(s, "input_schema") {
		t.Errorf("anthropic-only fields leaked: %s", s)
	}
}

func TestFromOpenAIToolCallsAndUsage(t *testing.T) {
	status, body := fromOpenAI(200, []byte(`{"id":"c1","model":"gpt-x","choices":[{"finish_reason":"tool_calls","message":{"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"query_loki","arguments":"{\"expr\":\"{app=\\\"x\\\"}\"}"}},{"id":"call_2","type":"function","function":{"name":"bad","arguments":"not json"}}]}}],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":60}}}`))
	if status != 200 {
		t.Fatalf("status %d %s", status, body)
	}
	var r struct {
		StopReason string           `json:"stop_reason"`
		Content    []map[string]any `json:"content"`
		Usage      map[string]int   `json:"usage"`
	}
	_ = json.Unmarshal(body, &r)
	if r.StopReason != "tool_use" || len(r.Content) != 2 || r.Content[0]["type"] != "tool_use" || r.Content[0]["name"] != "query_loki" {
		t.Fatalf("%s", body)
	}
	if r.Content[0]["input"].(map[string]any)["expr"] != `{app="x"}` {
		t.Fatalf("input %v", r.Content[0]["input"])
	}
	if r.Content[1]["input"].(map[string]any)["_raw_arguments"] != "not json" {
		t.Fatalf("bad args not preserved: %v", r.Content[1])
	}
	if r.Usage["input_tokens"] != 40 || r.Usage["cache_read_input_tokens"] != 60 || r.Usage["output_tokens"] != 20 {
		t.Fatalf("usage %v", r.Usage)
	}
}

func TestFromOpenAITextLengthAndErrors(t *testing.T) {
	_, body := fromOpenAI(200, []byte(`{"id":"c","choices":[{"finish_reason":"length","message":{"content":"partial"}}]}`))
	if !strings.Contains(string(body), `"stop_reason":"max_tokens"`) || !strings.Contains(string(body), `"text":"partial"`) {
		t.Fatalf("%s", body)
	}
	status, body := fromOpenAI(400, []byte(`{"error":{"message":"This model's maximum context length is 128000 tokens","type":"invalid_request_error"}}`))
	if status != 400 || !strings.Contains(string(body), "maximum context length") || !strings.Contains(string(body), `"type":"error"`) {
		t.Fatalf("%d %s", status, body)
	}
	status, _ = fromOpenAI(200, []byte(`{"choices":[]}`))
	if status != 502 {
		t.Fatalf("empty choices: %d", status)
	}
}

func TestOpenAIModeEndToEnd(t *testing.T) {
	srv, c := upstream(t, 200, `{"id":"c","model":"llama","choices":[{"finish_reason":"stop","message":{"content":"hello"}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}`)
	ds := newDS(t, srv.URL, `{"authMethod":"apiKey","apiKeyHeader":"api-key","apiFormat":"openai","defaultModel":"llama"}`, map[string]string{"apiKey": "azure-key"})
	s := callMessages(t, ds, `{"system":"sys","messages":[{"role":"user","content":"hi"}]}`, nil, nil)
	if s.status != 200 || !strings.Contains(string(s.body), `"text":"hello"`) || !strings.Contains(string(s.body), `"stop_reason":"end_turn"`) {
		t.Fatalf("%d %s", s.status, s.body)
	}
	if c.path != "/v1/chat/completions" || c.headers.Get("api-key") != "azure-key" || c.headers.Get("anthropic-version") != "" {
		t.Fatalf("path %s headers %v", c.path, c.headers)
	}
	if c.body["messages"].([]any)[0].(map[string]any)["role"] != "system" {
		t.Fatalf("body %v", c.body)
	}
}
