// Minimal Anthropic Messages API types used by the agent.

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  cache_control?: { type: 'ephemeral' };
}

export interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  [k: string]: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: 'ephemeral' };
}

export interface MessagesRequest {
  model?: string;
  system?: string | TextBlock[];
  messages: Message[];
  tools?: ToolSchema[];
  max_tokens?: number;
  temperature?: number;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface MessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal' | string | null;
  usage?: Usage;
}

/** Calls the model. Implemented by the Claude datasource proxy (and by fakes in tests). */
export type ModelCaller = (req: MessagesRequest, signal: AbortSignal) => Promise<MessagesResponse>;

/** Thin HTTP abstraction over Grafana's backendSrv so tools are testable. */
export interface GrafanaHttp {
  get<T = unknown>(url: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  post<T = unknown>(url: string, body: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<T>;
  put?<T = unknown>(url: string, body: unknown, signal?: AbortSignal): Promise<T>;
}

export interface DataSourceInfo {
  uid: string;
  name: string;
  type: string;
  isDefault?: boolean;
}

export interface TimeRangeMs {
  from: number;
  to: number;
}

export interface ApprovalRequest {
  title: string;
  detail: string;
}

/** One executed data query, recorded so findings can be reproduced and verified later. */
export interface EvidenceRecord {
  id: string; // E1, E2, … (stable within a session)
  tool: string;
  toolUseId?: string;
  agent?: string;
  datasource: { uid: string; type: string; name: string };
  query: Record<string, unknown>;
  from: string; // absolute ISO time range actually queried
  to: string;
  digest: string; // "sha256:<hex>" of the raw response (or "fnv1a:" where WebCrypto is unavailable)
  frames: number;
  rows: number;
  at: number;
}

export interface Hypothesis {
  id: string;
  statement: string;
  status: 'open' | 'supported' | 'refuted' | 'confirmed';
  confidence: number;
  evidence?: string;
  challenged?: boolean;
  updatedAt: number;
}

export interface ToolContext {
  http: GrafanaHttp;
  listDataSources: () => DataSourceInfo[];
  /** Default range for tools when the model omits start/end. */
  timeRange: TimeRangeMs;
  now: () => number;
  signal: AbortSignal;
  /** Investigation findings sink. */
  recordFinding?: (f: Finding) => void;
  /** Hypothesis board sink. */
  updateHypothesis?: (h: Hypothesis) => void;
  /** Hand a write action to the UI for explicit user approval. */
  propose?: (p: import('./proposals').Proposal) => void;
  /** Ask the user to approve a potentially side-effecting tool call (e.g. MCP). */
  confirm?: (r: ApprovalRequest) => Promise<boolean>;
  /** Name of the sub-agent running this tool, if any. */
  agent?: string;
  /** Evidence ledger sink; returns the assigned evidence id. */
  recordEvidence?: (e: Omit<EvidenceRecord, 'id'>) => string;
  /** Set by the runner for the duration of one tool call. */
  currentTool?: { name: string; id: string };
  /** The newest unsaved dashboard draft in this conversation (for incremental edits). */
  latestDraft?: () => import('./dashboard').DashboardDraft | undefined;
}

export interface Finding {
  title: string;
  detail: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  evidence?: string;
  at: number;
}

export interface ToolDefinition {
  schema: ToolSchema;
  /** Returns text for the model. Throwing produces an is_error tool_result. */
  run: (input: Record<string, any>, ctx: ToolContext) => Promise<string>;
  /** Short human label for the progress timeline. */
  describe?: (input: Record<string, any>) => string;
  /** True when the tool cannot change anything (safe for sub-agents without user approval). */
  readOnly?: boolean;
}

export type AgentMode = 'chat' | 'investigate';

export type AgentEvent =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_start'; id: string; name: string; label: string; input: Record<string, unknown>; agent?: string }
  | { kind: 'tool_end'; id: string; name: string; ok: boolean; output: string; ms: number; agent?: string }
  | { kind: 'finding'; finding: Finding }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'status'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'done'; stopReason: string; steps: number };
