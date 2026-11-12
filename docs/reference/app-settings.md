# App settings

`jsonData` of the `augur-assistant-app` plugin. Edit them in **Augur settings** or [provision them](../configure/app-settings.md#provisioning-everything).

| Field | Type | Default | Description |
|---|---|---|---|
| `rules` | list | none | `{ id, text, scope: all\|chat\|investigate\|dashboards, enabled }` |
| `skills` | list | none | `{ name, title, description, tags?, body, enabled }`; `name` is the `/command` |
| `investigationFolderUid` | string | General | Folder for saved investigations |
| `maxTokensPerRun` | int | `1500000` | Token ceiling per run, sub-agents included (input + output + cache writes, cache reads weighted 10%) |
| `stepBudget.chat` | int | `15` | Maximum agent steps in chat |
| `stepBudget.investigate` | int | `45` | Maximum agent steps in investigations |
| `enableSubAgents` | bool | `true` | Parallel specialists in investigations |
| `historyRetentionDays` | int | none | Conversations in users' browsers not updated for this many days are deleted (pinned ones kept) |
| `memory` | object | none | Infrastructure memory, written by **Scan now** |

## Stored in the browser

| Key prefix `augur-assistant-app/` | Contents |
|---|---|
| sessions and history | Conversations (60 most recent) and run checkpoints |
| `lease/<id>` | Cross-tab run leases |
| `personal-rules` | The user's personal rules |
| `conversations-rail` | Whether the conversations rail is open |
| `saved-drafts` | Which dashboard (and Grafana version) each draft lineage was saved to |
| `deleted` | Ids of deleted conversations, so nothing can restore them |
| `claim/<id>` | Run-lock fallback for browsers without the Web Locks API |
