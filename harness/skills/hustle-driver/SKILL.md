---
name: hustle-driver
description: One planning tick for the hustle board. Reads the charter, ledger and board, then writes the next cards or unblocks a stuck one. Attached to the driver cron job.
metadata:
  version: 0.1.0
---

# A tick

1. Read `/Users/hustle/project/CHARTER.md`, `LEDGER.md`, `DECISIONS.md`, and `research/channels.md` if present.
2. `kanban_list`. Handle `owner-override` cards first: read each, comment your plan change on it, then `kanban_complete` it once the plan reflects it.
3. Count cards in `ready`. If five or more, write nothing new; go to step 6.
4. Name the highest-risk unknown in one sentence in your reasoning. Write one to three cards with `kanban_create`, assignee `hustle-builder`, body in this shape:

   Type: research | experiment | code | content | security
   Phase: discover | prove-demand | build | launch-readiness
   Brief: <one paragraph>
   Exit evidence: <what the Critic will check, concretely>

5. For each card in `blocked`: read the reason. `needs_input` on spend or credential: leave it, and create a card for `hustle-reporter` tagged `exception` if none exists in the last 24 hours. Any other reason: rewrite the approach and `kanban_unblock`, or replace it with a smaller card.
6. Apply the phase rule from the charter (build may not run three days without a demand-side card closing).
7. If this is a fifth tick (count ticks in the ledger), write the premortem card.
8. Append to `LEDGER.md`: `YYYY-MM-DD HH:MM driver tick N | phase | wrote: <ids> | because: <one sentence> | number: <the one metric>`.
