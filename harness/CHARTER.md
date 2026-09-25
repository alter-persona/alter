# Charter

The Driver reads this file at the start of every tick. It is the only source of intent. Edit it to steer; do not message the agent.

## Goal

<!-- Paste the meta idea here in plain language: what it is, who it is for, why now. Two to six sentences. -->

## Launch gate (the one human decision)

Launch-ready means all of the following are true and evidenced on the board:

1. A public site is live on a free host with a working signup that stores to a database.
2. The onboarding email sequence (3 emails) sends from Brevo to a test signup.
3. The ingestion routines pass their automated tests in CI, and the test run is linked from the card.
4. The security checklist in `research/security.md` has every row marked done or accepted with a reason.
5. `research/channels.md` scores at least five distribution experiments with signups per hour of effort.
6. A launch brief exists at `reports/launch-brief.md`: segment, message, price, channel plan, first-week plan, risks.

When all six hold, the Driver writes the launch brief card, the Critic accepts it, and the digest asks the owner for the go decision. The agent does not launch.

## Phase exit criteria

- Discover exits when `research/positioning.md` names one beachhead segment, one buyer, one trigger moment, three alternatives, a pricing hypothesis, and a one-sentence message, each with at least one cited source.
- Prove demand exits when the site has a signup store with real entries and five scored channel experiments.
- Build exits when the ingestion tests are green in CI and the site talks to the services.
- Launch readiness exits at the launch gate.

## Constraints

- No cold email as a lead source. Email only follows a signup.
- Spend cap: 50 USD total without asking. A domain purchase counts. Above the cap, write the decision to `DECISIONS.md`, leave the card blocked with reason `needs_input`, and let the digest carry it.
- Prefer free tiers: Cloudflare Pages, Workers, D1; GitHub; Brevo free plan.
- Everything the agent writes lives under the project folder and is committed to git after each card.
- Never wait for the owner. Take the default below, record it, continue.

## Defaults when a choice is open

- Segment choice: pick the segment with the shortest path to a paying user, not the largest.
- Tech choice: pick the option with the fewest moving parts that runs on a free tier.
- Copy choice: ship two variants and measure rather than debate.
- Anything else: pick the reversible option, log it in `DECISIONS.md`, move on.

## Owner overrides

Cards tagged `owner-override` come from the owner's replies to the digest. They outrank every other card. The Driver reads them first each tick and rewrites the plan to fit.
