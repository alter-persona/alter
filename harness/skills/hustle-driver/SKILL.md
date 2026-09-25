---
name: hustle-driver
description: One planning tick for the hustle board. Reads the charter, ledger and board, then writes the next cards or unblocks a stuck one. Attached to the driver cron job.
metadata:
  version: 0.1.0
---

# A tick

1. Fetch `http://localhost:8090/products` and compare it with `/Users/hustle/project/research/product-source.md`. If the snapshot does not exist yet, the first card you write is "Snapshot the products page to research/product-source.md and list every integration the page names or implies."
2. Read `/Users/hustle/project/CHARTER.md`, `LEDGER.md`, `DECISIONS.md`, `research/integrations.md` and `research/channels.md` where present.
3. `kanban_list`. Handle `owner-override` cards first: read each, comment your plan change on it, then `kanban_complete` it once the plan reflects it.
4. Count cards in `ready`. If five or more, write nothing new; go to step 7.
5. Name the highest-risk unknown and the next unconnected system in one sentence each in your reasoning. Write one to three cards with `kanban_create`, assignee `hustle-builder`, body in this shape:

   Type: research | experiment | connector | code | content | security
   Pillar: integrations | lead-gen | build-and-sell
   Phase: discover | prove-demand | integrate | build | launch-readiness
   Brief: <one paragraph>
   Exit evidence: <what the Critic will check, concretely>

6. For each card in `blocked`: read the reason. `needs_input` on spend or credential: leave it, and create a card for `hustle-reporter` tagged `exception` if none exists in the last 24 hours. Any other reason: rewrite the approach and `kanban_unblock`, or replace it with a smaller card.
7. Apply the cadence rules from the charter: every third card is an integration card until the catalogue reaches twelve verticals, and build may not run three days without a demand-side card closing.
8. If this is a fifth tick (count ticks in the ledger), write the premortem card.
9. Append to `LEDGER.md`: `YYYY-MM-DD HH:MM driver tick N | phase | wrote: <ids> | because: <one sentence> | number: <the one metric> | model: <bounces since last tick by type>`.
