# Charter

The Driver reads this file at the start of every tick. It is the only source of intent. Edit it to steer; do not message the agent.

## Product source of truth

The product is described at `http://localhost:8090/products`, the output of the idea-generation agent on this machine. The Driver fetches that page at the start of every tick and treats it as the specification. The first card of the project snapshots it to `research/product-source.md` with a date, and every later tick diffs the live page against the snapshot and records any change in `LEDGER.md`. If the page is unreachable, the snapshot stands in and the ledger notes the outage.

## Goal

Build and take to launch the follow-up engine described on the products page: a service that connects to whatever backend system a small business already runs, and from that data keeps up constant, relevant follow-up with the business's customers so that no lead or lapsed customer goes quiet.

The thesis has three pillars, and every card serves one of them:

1. Integrations. The product is only as valuable as the number of backend systems it can read from and write to. A gym runs a membership system, a beautician runs a booking app, a tradesperson runs a calendar and an invoicing tool. For each vertical the agent must answer: which systems do they run, how does the product connect (API, OAuth, CSV export, email parsing, calendar feed), what data flows each way, and what does the follow-up look like once connected. Breadth of integration is the moat.
2. Lead generation for the product itself, without cold email as a source.
3. Build and sell: the connectors, the ingestion, the tests, the pricing model, and the pitch that convinces a business owner to connect a system and run a test.

## Launch gate (the one human decision)

Launch-ready means all of the following are true and evidenced on the board:

1. A public site is live on a free host with a working signup that stores to a database.
2. The onboarding email sequence (3 emails) sends from Brevo to a test signup.
3. `research/integrations.md` catalogues at least eight verticals, and for each names the top three backend systems with their connection method, auth model and data available.
4. At least three connectors work end to end against a sandbox or recorded fixtures, with tests, and feed the follow-up engine's data model.
5. The ingestion routines pass their automated tests in CI, and the test run is linked from the card.
6. The security checklist in `research/security.md` has every row marked done or accepted with a reason.
7. `research/channels.md` scores at least five distribution experiments with signups per hour of effort.
8. `research/pricing.md` states the pricing model, the pilot offer, and the conversion path from "connect one system" to paying.
9. A launch brief exists at `reports/launch-brief.md`: segment, message, price, integration list, channel plan, first-week plan, risks.

When all nine hold, the Driver writes the launch brief card, the Critic accepts it, and the digest asks the owner for the go decision. The agent does not launch.

## Phase exit criteria

- Discover exits when `research/positioning.md` names one beachhead segment, one buyer, one trigger moment, three alternatives, a pricing hypothesis, and a one-sentence message, each with at least one cited source, and `research/integrations.md` exists with at least four verticals filled in.
- Prove demand exits when the site has a signup store with real entries and five scored channel experiments.
- Integrate exits when three connectors pass the connector rubric and the catalogue reaches eight verticals. This phase runs alongside build and never pauses: every third card the Driver writes is an integration card until the catalogue reaches twelve verticals.
- Build exits when the ingestion tests are green in CI and the site talks to the services.
- Launch readiness exits at the launch gate.

## The model

Everything runs on the local model on this machine, served at `http://127.0.0.1:11434/v1`. The Driver, the Builder, the Critic and the Reporter all use it. This project is a test of that model as much as it is a product, so the ledger records how the model behaves: bounce rate by card type, cards that needed a second attempt, and cards the Driver had to split. No frontier model is called unless the owner changes the config.

## Constraints

- No cold email as a lead source. Email only follows a signup.
- Spend cap: 50 USD total without asking. A domain purchase counts. Above the cap, write the decision to `DECISIONS.md`, leave the card blocked with reason `needs_input`, and let the digest carry it.
- Prefer free tiers: Cloudflare Pages, Workers, D1; GitHub; Brevo free plan.
- Everything the agent writes lives under the project folder and is committed to git after each card.
- Never wait for the owner. Take the default below, record it, continue.
- Connectors are built against public sandboxes, recorded fixtures or documented export formats. The agent never signs up to a vendor on the owner's behalf if that needs a card or a phone number; it records the need in `DECISIONS.md` and builds against fixtures.

## Defaults when a choice is open

- Segment choice: pick the segment with the shortest path to a paying user, not the largest.
- Tech choice: pick the option with the fewest moving parts that runs on a free tier.
- Copy choice: ship two variants and measure rather than debate.
- Anything else: pick the reversible option, log it in `DECISIONS.md`, move on.

## Owner overrides

Cards tagged `owner-override` come from the owner's replies to the digest. They outrank every other card. The Driver reads them first each tick and rewrites the plan to fit.
