# Conversations

Chats and investigations are kept as conversations you can switch between.

## The conversations list

- On the Augur page it's a **rail** on the left; toggle it with the **Conversations** button. In the sidebar it's a list that opens over the chat.
- Grouped as **Running**, **Pinned**, **Today**, **Yesterday**, **Previous 7 days** and **Older**.
- **Search** by title.
- **Rename**, **Pin/Unpin** and **Delete** from each conversation's menu. Deleting a running conversation stops it first.
- Badges show conversations that **need approval** (a proposal or tool is waiting for you) and runs that were **interrupted** (resume them).

## Running several at once

Switching conversations doesn't stop a run. Up to **three** conversations can run in parallel in the background. The header shows how many are running, and starting a fourth tells you to wait or stop one.

**Stop** applies only to the conversation you have open.

## Several tabs

Only one tab drives a given run at a time. Other tabs show *Running in another tab*, and take over automatically if that tab goes away (a 12-second lease). Different conversations can run in different tabs.

## Where conversations are stored

In your browser's local storage, per Grafana origin. Augur keeps the **60** most recent, and pinned ones stay at the top. When storage gets tight it compacts older conversations first (drops the step-by-step transcript, then shortens long tool outputs) before removing any.

Conversations don't sync across browsers or devices. To share an investigation, [save it to Grafana or export it](reports.md).
