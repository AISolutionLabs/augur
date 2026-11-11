import { Capabilities, capabilitiesTool } from '../capabilities';
import { AgentMode, ToolDefinition } from '../types';
import { Proposal } from '../proposals';
import { Skill, InfraMemory } from '../../settings';
import { observabilityTools } from './observability';
import { grafanaObjectTools, recordFinding } from './grafanaObjects';
import { draftDashboardTool, listFolders, reviseDraftTool } from './dashboards';
import { actionTools, listSilences, queryProfiles } from './actions';
import { memoryTool, readPastInvestigation, searchPastInvestigations, skillTools } from './knowledge';
import { delegateTool, DelegateDeps, hypothesisTool } from './investigation';

export interface ToolsetDeps {
  /** UI sink for proposals. Without it, proposal tools are not offered to the model at all. */
  propose?: (p: Proposal) => void;
  skills: Skill[];
  memory?: InfraMemory;
  mcp: ToolDefinition[];
  /** Enables the delegate tool in investigations. */
  delegate?: Omit<DelegateDeps, 'subTools'>;
  /** What this Grafana has installed (enables grafana_capabilities). */
  capabilities?: () => Promise<Capabilities>;
}

/**
 * Read-only tools shared by the lead agent and sub-agents. MCP tools are included only when the
 * server annotates them read-only; anything that may change state stays with the lead agent, where
 * the user approves each call.
 */
export function readOnlyTools(deps: Partial<ToolsetDeps>): ToolDefinition[] {
  return [
    ...observabilityTools,
    queryProfiles,
    ...grafanaObjectTools,
    listFolders,
    listSilences,
    ...skillTools(deps.skills ?? []),
    ...memoryTool(deps.memory),
    searchPastInvestigations,
    readPastInvestigation,
    ...(deps.capabilities ? [capabilitiesTool(deps.capabilities)] : []),
    ...(deps.mcp ?? []).filter((t) => t.readOnly === true),
  ];
}

export function buildToolset(mode: AgentMode, deps: Partial<ToolsetDeps> = {}): ToolDefinition[] {
  const { propose } = deps;
  const tools: ToolDefinition[] = [
    ...readOnlyTools(deps),
    // Proposal tools only exist when a UI can show the proposal to a user.
    ...(propose
      ? [
          draftDashboardTool((d) => propose({ kind: 'dashboard', id: d.id, draft: d })),
          reviseDraftTool((d) => propose({ kind: 'dashboard', id: d.id, draft: d })),
          ...actionTools.filter((t) => t !== listSilences),
        ]
      : []),
    ...(deps.mcp ?? []),
  ];
  if (mode === 'investigate') {
    tools.push(recordFinding, hypothesisTool());
    if (deps.delegate) {
      const readOnly = readOnlyTools(deps);
      tools.push(delegateTool({ ...deps.delegate, subTools: () => [...readOnly, recordFinding] }));
    }
  }
  // Tool names must be unique for the API (MCP names are already made unique in mcpTools; this is a
  // last line of defence).
  const seen = new Set<string>();
  return tools.filter((t) => (seen.has(t.schema.name) ? false : (seen.add(t.schema.name), true)));
}
