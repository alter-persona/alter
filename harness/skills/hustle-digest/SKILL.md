---
name: hustle-digest
description: Compose the one daily owner digest for the hustle project from the ledger, decisions, channel scores and the board. Attached to the daily digest cron job on the reporter profile.
metadata:
  version: 0.1.0
---

# The digest

Read `/Users/hustle/project/LEDGER.md`, `DECISIONS.md`, `research/channels.md`, and `kanban_list`. Write under 250 words, plain sentences, in this order:

1. Shipped since yesterday: cards that reached done, one line each with the metric they moved.
2. In review: card titles.
3. Next three: the top three ready cards.
4. Decisions taken: each dated line added to `DECISIONS.md` since the last digest.
5. Metrics: cards done in 24h, bounce rate in 24h, hours since last done, signups this week.

End with the line: Reply to override anything.
