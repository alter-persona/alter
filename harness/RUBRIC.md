# Critic rubric

The Critic scores every card in review against the section that matches the card's `type` label, then the common section. A card passes only when every required row passes. The Critic writes the failing rows, numbered, into `kanban_request_changes`. It never fixes the work itself.

## Common (every card)

| Row | Required | Passes when |
| --- | --- | --- |
| Evidence present | Yes | The completion summary shows the exact commands run and their output, or a URL that loads, or a file path that exists in the repo. |
| Committed | Yes | A git commit hash is named and `git show <hash> --stat` lists the files claimed. |
| Scope honored | Yes | The work does what the card asked, no more. Extra work goes on a new card. |
| Charter honored | Yes | No constraint in `CHARTER.md` is broken. Cold outreach email anywhere fails this row. |
| Decision logged | If a choice was made | `DECISIONS.md` has a dated line with the choice and the default rule applied. |

## Type: research

| Row | Required | Passes when |
| --- | --- | --- |
| Sourced | Yes | Every claim that could be wrong has a URL, and the URL was fetched during the card (the fetch appears in evidence). |
| Specific | Yes | Segments, buyers and competitors are named. "SMBs" fails. "Independent physiotherapists in the UK who book via WhatsApp" passes. |
| Falsifiable | Yes | The doc names what evidence would prove the positioning wrong. |
| Numbers | Yes | Any market size, price or volume states how it was calculated. |

## Type: experiment (distribution and messaging)

| Row | Required | Passes when |
| --- | --- | --- |
| Hypothesis | Yes | One sentence: channel, audience, expected signal, by when. |
| Ran | Yes | The experiment went live: a URL, a post link, a listing, a submission receipt. A plan is not an experiment. |
| Scored | Yes | `research/channels.md` has the row: hours spent, cost, signups or replies, signups per hour. Zero is a valid score. |
| Next | Yes | The row says keep, scale or kill, with the reason. |

## Type: code

| Row | Required | Passes when |
| --- | --- | --- |
| Tests | Yes | New behavior has a test, the test run output is in the evidence, and it is green. |
| Runs | Yes | The service starts and a request against it is shown. For a site, the URL loads. |
| Free tier | Yes | The hosting choice is on a free tier, named in the card. |
| Secrets | Yes | No credential appears in the diff. `git diff <hash>~1 <hash> | grep -iE 'key|token|secret'` shows only variable names. |
| Ingestion (if applicable) | Yes | A malformed input, an empty input and a duplicate input each have a test. |

## Type: content (site copy, emails, campaign assets)

| Row | Required | Passes when |
| --- | --- | --- |
| For the segment | Yes | The copy names the buyer's situation from `research/positioning.md`, not a generic audience. |
| One ask | Yes | Each page or email has one call to action. |
| Two variants | Yes | Headlines and email subject lines ship as A and B. |
| Sendable | For emails | The email renders in Brevo's preview and a test send arrived; the evidence shows the send id. |
| Honest | Yes | No claim the product cannot meet today. |

## Type: security

| Row | Required | Passes when |
| --- | --- | --- |
| Checklist | Yes | `research/security.md` covers: secrets in env only, input validation on every ingestion path, rate limits on public endpoints, dependency audit output, data retention stated, HTTPS only. |
| Verified | Yes | Each row cites the command or file that proves it. |

## Bar raising

After the Critic has passed ten cards of one type, it adds one stricter row to that type's table in this file and logs the change in `DECISIONS.md`. The bar goes up, never down.
