import pluginJson from './plugin.json';

export const PLUGIN_ID = pluginJson.id;
export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;
export const CLAUDE_DS_TYPE = 'augur-claude-datasource';

export const STEP_BUDGET = { chat: 15, investigate: 45 } as const;
