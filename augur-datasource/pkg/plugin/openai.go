package plugin

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Translation between the Anthropic Messages API (Augur's internal format) and the OpenAI Chat
// Completions API, for gateways or models that only speak the latter (Azure OpenAI, vLLM, Ollama,
// OpenAI-compatible LiteLLM routes). Only the subset Augur uses is translated: text, tool use and
// tool results. Thinking blocks and cache_control hints are dropped.

type anthBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
}

type anthMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type anthTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

type oaiToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type oaiMessage struct {
	Role       string        `json:"role"`
	Content    *string       `json:"content"`
	ToolCalls  []oaiToolCall `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
}

func strPtr(s string) *string { return &s }

// blocksOf decodes Anthropic content, which is either a string or an array of blocks.
func blocksOf(raw json.RawMessage) ([]anthBlock, error) {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, err
		}
		return []anthBlock{{Type: "text", Text: s}}, nil
	}
	var blocks []anthBlock
	err := json.Unmarshal(raw, &blocks)
	return blocks, err
}

// toolResultText flattens tool_result content (string or text blocks) to a string.
func toolResultText(raw json.RawMessage) string {
	blocks, err := blocksOf(raw)
	if err != nil {
		return string(raw)
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// toOpenAI converts an Anthropic-format request body into a Chat Completions request body.
func toOpenAI(in upstreamBody, maxTokensField string) (map[string]any, error) {
	var msgs []oaiMessage
	if sys := strings.TrimSpace(toolResultText(in.System)); sys != "" {
		msgs = append(msgs, oaiMessage{Role: "system", Content: strPtr(sys)})
	}
	var anth []anthMessage
	if err := json.Unmarshal(in.Messages, &anth); err != nil {
		return nil, fmt.Errorf("messages: %w", err)
	}
	for _, m := range anth {
		blocks, err := blocksOf(m.Content)
		if err != nil {
			return nil, fmt.Errorf("message content: %w", err)
		}
		switch m.Role {
		case "assistant":
			out := oaiMessage{Role: "assistant"}
			var text []string
			for _, b := range blocks {
				switch b.Type {
				case "text":
					text = append(text, b.Text)
				case "tool_use":
					tc := oaiToolCall{ID: b.ID, Type: "function"}
					tc.Function.Name = b.Name
					args := strings.TrimSpace(string(b.Input))
					if args == "" || args == "null" {
						args = "{}"
					}
					tc.Function.Arguments = args
					out.ToolCalls = append(out.ToolCalls, tc)
				}
			}
			if len(text) > 0 {
				out.Content = strPtr(strings.Join(text, "\n"))
			}
			msgs = append(msgs, out)
		default: // user
			var text []string
			for _, b := range blocks {
				switch b.Type {
				case "tool_result":
					content := toolResultText(b.Content)
					if b.IsError {
						content = "ERROR: " + content
					}
					msgs = append(msgs, oaiMessage{Role: "tool", ToolCallID: b.ToolUseID, Content: strPtr(content)})
				case "text":
					text = append(text, b.Text)
				}
			}
			if len(text) > 0 {
				msgs = append(msgs, oaiMessage{Role: "user", Content: strPtr(strings.Join(text, "\n"))})
			}
		}
	}

	if maxTokensField == "" {
		maxTokensField = "max_tokens"
	}
	out := map[string]any{"model": in.Model, "messages": msgs, maxTokensField: in.MaxTokens}
	if in.Temperature != nil {
		out["temperature"] = *in.Temperature
	}
	if len(in.StopSequences) > 0 {
		out["stop"] = in.StopSequences
	}
	if u := in.Metadata["user_id"]; u != "" {
		out["user"] = u
	}

	if len(in.Tools) > 0 && string(in.Tools) != "null" {
		var tools []anthTool
		if err := json.Unmarshal(in.Tools, &tools); err != nil {
			return nil, fmt.Errorf("tools: %w", err)
		}
		oaiTools := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			params := t.InputSchema
			if len(params) == 0 {
				params = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			oaiTools = append(oaiTools, map[string]any{
				"type":     "function",
				"function": map[string]any{"name": t.Name, "description": t.Description, "parameters": params},
			})
		}
		out["tools"] = oaiTools
	}
	if len(in.ToolChoice) > 0 && string(in.ToolChoice) != "null" {
		var tc struct {
			Type string `json:"type"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(in.ToolChoice, &tc); err == nil {
			switch tc.Type {
			case "none":
				out["tool_choice"] = "none"
			case "any":
				out["tool_choice"] = "required"
			case "tool":
				out["tool_choice"] = map[string]any{"type": "function", "function": map[string]any{"name": tc.Name}}
			case "auto":
				out["tool_choice"] = "auto"
			}
		}
	}
	return out, nil
}

type oaiResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Content   *string       `json:"content"`
			ToolCalls []oaiToolCall `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens        int `json:"prompt_tokens"`
		CompletionTokens    int `json:"completion_tokens"`
		PromptTokensDetails *struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

var finishToStop = map[string]string{
	"stop":           "end_turn",
	"tool_calls":     "tool_use",
	"function_call":  "tool_use",
	"length":         "max_tokens",
	"content_filter": "refusal",
}

// fromOpenAI converts a Chat Completions response (or error) into the Anthropic response shape.
func fromOpenAI(status int, body []byte) (int, []byte) {
	var r oaiResponse
	if err := json.Unmarshal(body, &r); err != nil {
		if status >= 300 {
			return status, mustJSON(errorEnvelope("upstream_error", truncate(string(body), 500)))
		}
		return 502, mustJSON(errorEnvelope("invalid_upstream_response", "could not parse OpenAI-compatible response"))
	}
	if status >= 300 || r.Error != nil {
		msg := fmt.Sprintf("HTTP %d", status)
		typ := "upstream_error"
		if r.Error != nil {
			msg, typ = r.Error.Message, r.Error.Type
		}
		if status < 300 {
			status = 502
		}
		return status, mustJSON(errorEnvelope(typ, msg))
	}
	if len(r.Choices) == 0 {
		return 502, mustJSON(errorEnvelope("invalid_upstream_response", "no choices in response"))
	}
	c := r.Choices[0]
	content := []map[string]any{}
	if c.Message.Content != nil && strings.TrimSpace(*c.Message.Content) != "" {
		content = append(content, map[string]any{"type": "text", "text": *c.Message.Content})
	}
	for _, tc := range c.Message.ToolCalls {
		var input any
		if err := json.Unmarshal([]byte(tc.Function.Arguments), &input); err != nil || input == nil {
			input = map[string]any{"_raw_arguments": tc.Function.Arguments}
		}
		content = append(content, map[string]any{"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": input})
	}
	stop := finishToStop[c.FinishReason]
	if stop == "" {
		stop = "end_turn"
	}
	if len(c.Message.ToolCalls) > 0 {
		stop = "tool_use"
	}
	out := map[string]any{"id": r.ID, "type": "message", "role": "assistant", "model": r.Model, "content": content, "stop_reason": stop}
	if r.Usage != nil {
		u := map[string]any{"input_tokens": r.Usage.PromptTokens, "output_tokens": r.Usage.CompletionTokens}
		if r.Usage.PromptTokensDetails != nil {
			u["cache_read_input_tokens"] = r.Usage.PromptTokensDetails.CachedTokens
			u["input_tokens"] = r.Usage.PromptTokens - r.Usage.PromptTokensDetails.CachedTokens
		}
		out["usage"] = u
	}
	return 200, mustJSON(out)
}

func errorEnvelope(typ, msg string) map[string]any {
	return map[string]any{"type": "error", "error": map[string]string{"type": typ, "message": msg}}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
