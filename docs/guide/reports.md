# Reports and export

When an investigation has finished, the footer offers three ways to keep it.

## Save to Grafana

Creates a dashboard in the investigations folder containing:

- the report (summary, timeline, root cause, actions)
- findings and hypotheses
- evidence panels with the key queries
- annotations at the important moments
- the evidence ledger

It's an ordinary dashboard governed by folder permissions, so you can share a link, and Augur searches saved investigations in future incidents.

## Markdown

Downloads `augur-<date>.md` with the write-up, findings by severity, hypotheses by status, the evidence ledger and every query run. Paste it into a ticket, wiki or postmortem.

## PDF

Opens your browser's print dialog with a print-ready report. Choose **Save as PDF** as the destination.

The PDF contains:

- a header with the question, the time window (UTC), who ran it and when
- the write-up, formatted
- findings with severity badges
- hypotheses with status and confidence
- the evidence ledger (datasource, query, time range, frames/rows, response digest)
- every query executed (failed ones marked)

It's generated in your browser from the conversation: no server, no external service, and it works air-gapped.

!!! tip
    In the print dialog, turn off **Headers and footers** for a cleaner PDF, and keep **Background graphics** on so the badges print in color.

## The evidence ledger

Each entry records exactly which data a conclusion was based on: datasource, query, absolute time range, a SHA-256 digest of the response, and frame and row counts. Findings cite entries by id (`E3`). To recheck a finding later, rerun the query over the same range and compare.
