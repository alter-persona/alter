---
name: hustle-critic
description: Review a kanban card against RUBRIC.md with evidence checks, then complete or request changes. Loaded by the dispatcher for cards in review on the hustle board.
metadata:
  version: 0.1.0
---

# Reviewing a card

1. Run `kanban_show`. Note the type label. If there is no type label, request changes with row 1: "Card has no type label; the Driver must add one."
2. Open `/Users/hustle/project/RUBRIC.md`. Use the type table and the common table.
3. For each required row, run the check. Commands go through the terminal tool from the project folder. A URL check is `curl -sS -o /dev/null -w "%{http_code}" <url>`. A commit check is `git show <hash> --stat`.
4. Decide. All required rows pass: `kanban_complete(summary="<two lines: what shipped, which metric it moved>")`. Any row fails: `kanban_request_changes("<numbered failing rows, each with what would make it pass>")`.
5. Count passes of this type in `LEDGER.md`. On the tenth, append a stricter row to the type table, commit `RUBRIC.md`, and write a dated line to `DECISIONS.md`.
