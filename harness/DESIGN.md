# The push harness: design

A harness that takes one product idea and drives a local Hermes agent from idea to launch-ready without waiting for a human, while sending you one Telegram message a day.

## The one-paragraph story

Three Hermes profiles share one kanban board on the Mac Studio. The Driver reads the charter and the board every 30 minutes and asks one question: what is the highest-risk unknown right now, and which card retires it? It writes that card. The Builder picks the card up, does the work inside a protected folder, and hands it to review with evidence. The Critic scores the evidence against a fixed rubric and either accepts it or sends it back with what is missing. The board is durable SQLite, so the loop survives restarts, model crashes and days of wall clock. The Driver never asks you anything. It takes the default written in the charter, logs the decision, and moves on. Once a day it sends a digest. You reply to the digest to override anything.

## Why a board and not a chat loop

Hermes ships three ways to keep an agent going: `/goal` (a judge re-prompts the same session until done, 20 turns by default), `/loop` (re-fires a prompt on a cadence, 100 ticks by default) and `/heartbeat` (fires when idle). All three live inside one session, so the context grows until compression eats the plan, and a gateway restart strands them. A multi-day project needs its state in files and a queue, not in a context window. The kanban board gives that for free: eight columns, atomic claims, a 4-hour stale-worker reclaim, a review lane, and a dispatcher that runs inside the gateway. Each card runs as a fresh process with a clean context that reads the charter, the ledger and the card. That is the Ralph-loop pattern with a real queue underneath.

| Mechanism | Survives restart | Context per unit | Review lane | Fit |
| --- | --- | --- | --- | --- |
| `/goal` in one session | Yes, via resume | Grows unbounded | Judge only | First night only |
| `/loop` or `/heartbeat` | Session-bound | Grows unbounded | None | Status checks |
| Cron job per task | Yes | Fresh | None | The Driver tick |
| Kanban board | Yes | Fresh per card | Built in | The spine |

Sources for those limits: the Hermes docs on goals (`goals.max_turns: 20`), loops (`loops.max_ticks: 100`) and kanban (`kanban.dispatch_stale_timeout_seconds: 14400`, `kanban.failure_limit: 2`).

## The three roles

Driver. An orchestrator-lane profile whose toolset has the board, file reads and web search, and no terminal. It cannot build, so it cannot get lost building. A cron job runs it every 30 minutes as a one-shot chat in its own profile, so each tick starts with a fresh context. Each tick it reads `CHARTER.md`, `LEDGER.md` and the board, then does exactly one of: write the next one to three cards, unblock a blocked card with a different approach, or raise the bar by writing a premortem card. It ends every tick by appending a dated line to the ledger. It is the "now what?" voice.

Builder. A worker-lane profile with the full toolset, `--yolo`, and writes fenced to the project folder. The dispatcher spawns it when a card reaches `ready`. It reads the card, does the work, commits to git, and calls `kanban_request_review` with an evidence block: commands run, their output, URLs, screenshots, numbers. Work without evidence goes back.

Critic. A reviewer-lane profile on a different model from the Builder. Same-model review is soft review. It loads the rubric, checks the evidence, and calls `kanban_complete` or `kanban_request_changes` with a numbered list of what is missing. It never fixes the work itself. The bounce rate is a health metric, not a failure: below 20 percent the Critic is rubber-stamping, above 60 percent the Driver is writing bad cards.

The repo already runs this split: local model for runtime, frontier model for judgment (`config/improvement.json`). The harness reuses it. Builder on the local MLX model at zero marginal cost, Critic on Claude Sonnet under your key, Driver on the local model with a Sonnet fallback if its cards get bounced twice in a row.

## What the Driver pushes through, and in what order

The charter fixes the goal and the launch gate. The Driver owns the sequencing, and the sequence is ordered by what kills the product soonest. Reaching the market is the hard part, so demand evidence comes before code.

1. Discover. Name the beachhead segment inside the large market, the buyer, the trigger moment, the three competing alternatives, the pricing hypothesis, and the message in one sentence. Output: `research/positioning.md` with sources.
2. Prove demand without cold email. Ship a landing page on a free host with a waitlist. Run at least five distribution experiments in parallel and score each on time-to-signal, signups per hour of effort, and cost. Candidates the Driver must test before it can skip them: programmatic SEO pages per use case, a free tool that is itself useful (tool-led growth), listings in the ecosystems the product plugs into (skill hubs, MCP registries, integration marketplaces), community answers where the buyer already asks the question (Reddit, Hacker News, Discords), comparison pages against the named alternatives, an open-source top of funnel, short video scripts, and partner or affiliate offers. Email is allowed only as the follow-up to a signup, never as the source of one.
3. Build. Services, connectors, ingestion, tests for the ingestion, a security pass, and hosting on free tiers. The Driver may not let this phase run more than three days without a demand-side card closing in the same window.
4. Launch readiness. Onboarding email sequence in Brevo (300 sends a day on the free plan, per Brevo's plan page), analytics, support path, launch checklist, and a launch brief for you. The launch itself is the one human gate.

The Driver interleaves phases. It moves on when a phase's exit criterion in the charter is met, not when it feels done.

## Free-rein, protected

You said you will back up the Mac and do not care much if the agent deletes everything. Three cheap layers make that outcome unlikely without slowing the agent down.

- Run the whole thing as a separate standard macOS user named `hustle`. Filesystem permissions then keep your home directory unreadable and unwritable no matter what the terminal tool does. This is the layer that matters, because `HERMES_WRITE_SAFE_ROOT` fences only `write_file` and `patch`, not shell commands.
- Set `HERMES_WRITE_SAFE_ROOT=/Users/hustle/project` and `terminal.cwd` to the same folder, and add deny globs for `git push --force*`, `rm -rf ~*` and `sudo*`. Hermes keeps its hardline blocklist on even under `--yolo`.
- Git-init the project folder and have the Builder commit after every card. Rolling back a bad afternoon is one command.

External systems stay open on purpose. The Builder gets the credentials it needs through `terminal.env_passthrough` in the `hustle` user's Hermes `.env`. Pre-provision those accounts before you start (see the questions below), because a missing account is the main reason an agent reports "blocked".

## Reporting: one message a day

The rule is that the agent never waits and never narrates. Concretely:

- The Builder and Critic never message you. Board notifications to the gateway are switched off (`kanban.notify_in_gateway: false`).
- The Driver writes decisions to `DECISIONS.md` with the default it took and why. It does not ask.
- A daily cron at 07:45 delivers one digest to Telegram: shipped, in review, next three cards, decisions taken, and metrics. That is the whole status surface. Ten messages a day becomes one.
- Two exceptions can send an out-of-band message, and only once each per 24 hours: spend above the cap in the charter, or a credential the Builder cannot get. Everything else waits for the digest.
- You steer by replying to the digest. The reporter profile runs the Telegram gateway and turns your reply into a top-priority card tagged `owner-override`. The Driver reads those first.

## Metrics that show it is working

All counts come from the board's event log, which `hermes kanban list --json` and `hermes kanban watch` expose. The watchdog script computes them.

| Metric | How it is computed | Healthy range |
| --- | --- | --- |
| Cards completed per day | Count of `done` transitions in the last 24 hours | 6 to 20 |
| Critic bounce rate | `request_changes` divided by reviews in the last 24 hours | 20 to 60 percent |
| Hours since last `done` | Now minus the newest `done` timestamp | Under 6 |
| Owner messages per day | Telegram sends by the reporter profile | 1, plus at most 2 exceptions |
| Demand signal | Waitlist signups per week, from the landing page's store | Rising, and it must exist by day 3 |
| Channel experiments scored | Rows in `research/channels.md` with a signups-per-hour figure | 5 or more by day 5 |

The watchdog runs as a no-agent cron every 30 minutes and only speaks when hours-since-last-done passes 6 or the dispatcher is not running.

## Hosting and cost

The charter says as free as possible. The Builder's default stack for anything public: Cloudflare Pages for the site (unmetered static, 500 builds a month), Workers for the API (100,000 requests a day on the free plan), D1 for data (5 GB), and Brevo for transactional and onboarding email (300 a day). GitHub holds the code. The one predictable spend is a domain. The Critic's Sonnet calls are the only per-token cost, and the model runs only on review turns, which are short. Those free-tier figures come from the Cloudflare and Brevo pricing pages linked at the end of this document and should be rechecked on the day you provision.

## Rollout

Night one, one hour. Create the `hustle` user, install Hermes there, run `harness/install.sh`, paste the meta idea into `CHARTER.md`, and start the gateway. The first Driver tick writes the discovery cards. Nothing else needs you.

Day two. Read the first digest. Reply with any override. Check the bounce rate; tune the rubric if the Critic is soft.

Day five onward. Demand data exists. The Driver starts build cards. You receive the launch brief when the charter's launch gate is met, and you decide.

## What is in this folder

| File | Purpose |
| --- | --- |
| `CHARTER.md` | The intent: goal, launch gate, phase exits, constraints, defaults. Copied into the project folder; you edit it there. |
| `RUBRIC.md` | The Critic's tables, one per card type, plus the bar-raising rule. |
| `profiles/*/SOUL.md` | The four role prompts: driver, builder, critic, reporter. |
| `config/*.config.yaml` | Per-profile Hermes settings: models, toolsets, approvals, deny globs, board dispatch. |
| `skills/*/SKILL.md` | The tick, review and digest procedures as Hermes skills. |
| `driver-tick.sh`, `watchdog.sh` | The two no-agent cron scripts. |
| `install.sh` | Creates the folder, profiles, config, skills, board and cron jobs. |

## Questions for you before night one

- The meta idea is not in this repo. Paste it into `harness/CHARTER.md` under Goal, or send it and I will write the charter with exit criteria.
- Which accounts can the agent hold? Cloudflare, GitHub, Brevo, a domain registrar, and one social account at minimum. Creating them under a `hustle@` alias before the start removes the single biggest source of blocked cards.
- Spend cap. The charter defaults to 50 USD total without asking. Change it if you want more or zero.
- Critic model. I recommend Claude Sonnet under your existing key. A local critic reviewing a local builder will pass work it should bounce.
- Launch gate. The charter defines it as: live site, working signup, onboarding sequence sending, ingestion tests green, security checklist done, and a written launch brief. If launch means something else to you, change the gate.

## What I am not sure about

- Every Hermes command and config key in this design comes from the current docs (v0.14, May 2026). Run `hermes update` and `hermes doctor` on the Mac Studio first, and expect a flag or two to have moved.
- The local model has not run this loop for days at a stretch. The Critic on a frontier model is the guard, and the bounce rate is the early warning. If it climbs past 60 percent for a day, move the Driver to Sonnet as well.
- Whether the Driver picks good beachheads depends on the charter's constraints. A vague charter gives a vague plan. Spend the hour on it.

## Sources

- Hermes kanban, goals, loops, heartbeat, cron, delegation, security, hooks and memory docs at github.com/NousResearch/hermes-agent under `website/docs`.
- Brevo free plan: help.brevo.com, "About Brevo's pricing plans".
- Cloudflare Workers and Pages pricing: developers.cloudflare.com/workers/platform/pricing and developers.cloudflare.com/pages/functions/pricing.
