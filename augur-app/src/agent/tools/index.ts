import { AgentMode, ToolDefinition } from '../types';
import { DashboardDraft } from '../dashboard';
import { observabilityTools } from './observability';
import { grafanaObjectTools, recordFinding } from './grafanaObjects';
import { draftDashboardTool, listFolders } from './dashboards';

export function buildToolset(mode: AgentMode, onDraft: (d: DashboardDraft) => void): ToolDefinition[] {
  const tools = [...observabilityTools, ...grafanaObjectTools, listFolders, draftDashboardTool(onDraft)];
  if (mode === 'investigate') {
    tools.push(recordFinding);
  }
  return tools;
}
