import { AgentMode, ToolDefinition } from '../types';
import { Proposal } from '../proposals';
import { Skill, InfraMemory } from '../../settings';
import { observabilityTools } from './observability';
import { grafanaObjectTools, recordFinding } from './grafanaObjects';
import { draftDashboardTool, listFolders } from './dashboards';
import { actionTools, queryProfiles } from './actions';
import { memoryTool, readPastInvestigation, searchPastInvestigations, skillTools } from './knowledge';
import { delegateTool, DelegateDeps, hypothesisTool } from './investigation';

export interface ToolsetDeps {
  propose: (p: Proposal) => void;
  skills: Skill[];
  memory?: InfraMemory;
  mcp: ToolDefinition[];
  /** Enables the delegate tool in investigations. */
  delegate?: Omit<DelegateDeps, 'subTools'>;
}

/** Read-only tools shared by the lead agent and sub-agents. */
export function readOnlyTools(deps: Partial<ToolsetDeps>): ToolDefinition[] {
  return [
    ...observabilityTools,
    queryProfiles,
    ...grafanaObjectTools,
    listFolders,
    ...skillTools(deps.skills ?? []),
    ...memoryTool(deps.memory),
    searchPastInvestigations,
    readPastInvestigation,
  ];
}

export function buildToolset(mode: AgentMode, deps: Partial<ToolsetDeps> = {}): ToolDefinition[] {
  const propose = deps.propose ?? (() => undefined);
  const tools: ToolDefinition[] = [
    ...readOnlyTools(deps),
    draftDashboardTool((d) => propose({ kind: 'dashboard', id: d.id, draft: d })),
    ...actionTools,
    ...(deps.mcp ?? []),
  ];
  if (mode === 'investigate') {
    tools.push(recordFinding, hypothesisTool());
    if (deps.delegate) {
      const readOnly = readOnlyTools(deps);
      tools.push(delegateTool({ ...deps.delegate, subTools: () => [...readOnly, recordFinding] }));
    }
  }
  // Tool names must be unique for the API.
  const seen = new Set<string>();
  return tools.filter((t) => (seen.has(t.schema.name) ? false : (seen.add(t.schema.name), true)));
}
