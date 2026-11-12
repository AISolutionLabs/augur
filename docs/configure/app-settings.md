# Rules, skills and memory

Org admins configure Augur's knowledge under **Administration → Plugins → Augur → Augur settings**, or provision it from Git.

## Rules

Rules are short instructions that always apply, such as naming conventions, which datasource is production, or what to never do.

| Field | Values |
|---|---|
| `text` | The instruction |
| `scope` | `all`, `chat`, `investigate` or `dashboards` |
| `enabled` | `true` / `false` |

```yaml
rules:
  - { id: prod, scope: all, enabled: true, text: 'Production is the "Mimir prod" datasource; the cluster label is k8s_cluster.' }
  - { id: dash, scope: dashboards, enabled: true, text: 'Put new dashboards in the Platform folder and tag them team-platform.' }
```

Users can also add **personal rules**, stored in their own browser and applied only for them.

## Skills

Skills are Markdown runbooks. Augur finds relevant ones while it works (`search_skills`, `read_skill`), and users can run one directly as a command: `/kafka-lag orders-topic`.

```yaml
skills:
  - name: kafka-lag               # becomes /kafka-lag
    title: Kafka consumer lag
    description: Use when consumer lag alerts fire
    tags: [kafka, streaming]
    enabled: true
    body: |
      1. Query kafka_consumergroup_lag by consumergroup and topic for the last hour.
      2. Compare with producer rate (kafka_topic_partition_current_offset).
      3. Check consumer pod restarts and CPU throttling.
      4. Report which partitions lag and whether the trend is growing.
```

Import `.md` files with front matter in the settings page:

```markdown
---
name: kafka-lag
title: Kafka consumer lag
description: Use when consumer lag alerts fire
tags: [kafka]
---
1. Query kafka_consumergroup_lag ...
```

!!! tip "Writing good skills"
    Say **when** the skill applies in `description` (that's what Augur matches on), use the real metric and label names, and end with what the answer should contain.

## Infrastructure memory

**Scan now** builds a map of your services from your telemetry: services, namespaces and which signals cover them, plus service-to-service dependencies with rates and error rates from the Tempo service graph. It runs queries only and makes no model calls.

Augur reads the memory with `get_infrastructure_memory` at the start of investigations, so it starts with the right service names and knows where to look. Re-scan after big changes.

## Past investigations

Investigations saved to Grafana become memory too: Augur searches them (`search_past_investigations`) when a new incident looks similar. Choose the folder they go to:

```yaml
investigationFolderUid: incident-reviews
```

## Limits and behaviour

```yaml
maxTokensPerRun: 1500000       # per run, sub-agents included (cache reads weighted 10%)
stepBudget: { chat: 15, investigate: 45 }
enableSubAgents: true          # parallel specialists in investigations
historyRetentionDays: 30       # delete browser-stored conversations not updated for 30 days (pinned kept)
```

## Provisioning everything

```yaml title="provisioning/plugins/augur.yaml"
apiVersion: 1
apps:
  - type: augur-assistant-app
    org_id: 1
    jsonData:
      investigationFolderUid: incident-reviews
      enableSubAgents: true
      maxTokensPerRun: 1500000
      rules:
        - { id: prod, scope: all, enabled: true, text: 'Production is the "Mimir prod" datasource.' }
      skills:
        - name: kafka-lag
          title: Kafka consumer lag
          description: Use when consumer lag alerts fire
          enabled: true
          body: |
            1. Query kafka_consumergroup_lag by consumergroup and topic...
```

!!! warning
    Provisioned settings replace what's saved in the UI on restart. If you provision, treat Git as the source of truth.
