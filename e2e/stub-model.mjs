#!/usr/bin/env node
// Scripted Claude Messages API for end-to-end tests: replays a scenario's turns in order, so the
// whole Augur path (agent loop, tools, datasource backend, Grafana, datastores) runs for real
// without a model. Not a model: it does not read tool results, it only checks the request shape.
//
//   node stub-model.mjs scenarios/smoke.json [port]
//
// {{uid:<type>}} in a scenario is replaced with the uid of the first datasource of that type in
// the system prompt's inventory ("- prometheus: \"Name\" uid=abc").
import { createServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';

const [scenarioPath, port = '8787'] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const log = process.env.STUB_LOG;

const text = (s) => (typeof s === 'string' ? s : (s ?? []).map((b) => b.text ?? '').join('\n'));

function problems(req) {
  const p = [];
  if (!Array.isArray(req.messages) || req.messages.length === 0) p.push('messages missing');
  if (!req.max_tokens) p.push('max_tokens missing');
  const names = new Set((req.tools ?? []).map((t) => t.name));
  for (const n of scenario.requireTools ?? []) if (!names.has(n)) p.push(`tool ${n} not offered`);
  for (const m of req.messages ?? [])
    for (const b of Array.isArray(m.content) ? m.content : [])
      if (b.type === 'tool_result' && typeof b.content !== 'string' && !Array.isArray(b.content)) p.push('bad tool_result');
  return p;
}

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'stub-model', type: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404).end('{"error":{"message":"not found"}}');
      return;
    }
    const r = JSON.parse(body);
    const system = text(r.system);
    // Sub-agents get their own conversations; this stub only scripts the lead agent.
    const turn = r.messages.filter((m) => m.role === 'assistant').length;
    const bad = problems(r);
    const step = scenario.turns[Math.min(turn, scenario.turns.length - 1)];
    const uids = Object.fromEntries([...system.matchAll(/^- ([a-z-]+): ".*?" uid=(\S+)/gm)].reverse().map((m) => [m[1], m[2]]));
    const fill = (v) => JSON.parse(JSON.stringify(v).replace(/\{\{uid:([a-z-]+)\}\}/g, (_, t) => uids[t] ?? `missing-${t}`));
    const content = bad.length
      ? [{ type: 'text', text: `STUB REQUEST PROBLEMS: ${bad.join('; ')}` }]
      : fill(step).map((b, i) => (b.type === 'tool_use' ? { id: `toolu_${turn}_${i}`, ...b } : b));
    if (log) appendFileSync(log, JSON.stringify({ turn, model: r.model, tools: (r.tools ?? []).length, messages: r.messages.length, problems: bad }) + '\n');
    const out = {
      id: `msg_stub_${turn}`,
      type: 'message',
      role: 'assistant',
      model: r.model ?? 'stub',
      content,
      stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: { input_tokens: Math.round(body.length / 4), output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  });
}).listen(Number(port), '0.0.0.0', () => process.stderr.write(`stub model on :${port} (${scenario.turns.length} turns)\n`));
