# Runbook: from a fresh Mac Studio to a running harness

Nothing in this folder runs by itself. The harness starts when `install.sh` runs on the Mac Studio and the gateway starts. Until then the status page does not exist. Work down this list in order; each step names how to check it.

## 0. Before you start (five minutes)

- Back up the Mac.
- Confirm the local model server answers: `curl -s http://127.0.0.1:11434/v1/models | head -c 300` prints a model list.
- Confirm the products page answers: `curl -s http://localhost:8090/products | head -c 300` prints HTML.
- Have to hand: a Telegram bot token for the reporter (a new bot from BotFather, not the persona bot), your Telegram user id, and any service tokens you want the Builder to hold (Cloudflare, Brevo, GitHub).

## 1. The `hustle` user (ten minutes, recommended)

System Settings, Users and Groups, add a Standard user named `hustle`. Log in as `hustle` once so the home folder exists. Everything below runs as that user. Loopback ports (11434 for the model, 8090 for the products page) are shared across users, so nothing about the model changes.

To skip this and run as yourself: run the same commands from your own account with `HUSTLE_PROJECT=$HOME/hustle-project` exported first. The write fence then guards file tools only, so keep the backup.

## 2. Hermes for that user (five minutes)

Install Hermes for this user the same way you installed it for the persona profile (the install page at hermes-agent.nousresearch.com/docs has the current one-liner), then:

```bash
hermes update
hermes doctor
```

Check: `hermes doctor` shows no red lines. Then put the tokens in `~/.hermes/.env`:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=<your telegram user id>
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
BREVO_API_KEY=...
GITHUB_TOKEN=...
TEST_SIGNUP_EMAIL=you@example.com
```

Leave out any you do not have yet; the Builder logs the gap and builds against fixtures.

## 3. Install the harness (two minutes)

```bash
git clone https://github.com/alter-persona/alter.git ~/alter
pip3 install pyyaml
bash ~/alter/harness/install.sh
```

Check: the script prints steps 1 to 7 and ends with "Done". If a `hermes config set` or `hermes cron create` line errors, paste the error into the Claude session; a flag name has moved.

Then open `~/project/CHARTER.md` and read the Goal, the spend cap (50 USD) and the launch gate. Edit anything you disagree with. This is the one document the Driver treats as your intent.

## 4. Start it (one minute)

```bash
hermes -p hustle-reporter gateway start     # Telegram, the board dispatcher and the cron scheduler
hermes -p hustle-reporter gateway status    # check: running
~/project/harness/driver-tick.sh             # first Driver tick now, instead of in 30 minutes
tail -20 ~/project/harness/driver-tick.log   # check: the tick ran and wrote cards
hermes kanban list                           # check: cards in ready
```

Send your reporter bot one message in Telegram so the chat is registered. It replies with one line.

## 5. Watch (ongoing)

- `http://127.0.0.1:8091` is the status page. It renders every five minutes; force one now with `~/project/harness/status/render.sh`.
- `hermes kanban watch` streams board events. `hermes dashboard` opens the Hermes dashboard on port 9119.
- The daily digest arrives on Telegram at 07:45. Reply to it to override anything.

## What "working" looks like in the first hour

| Minute | Expect |
| --- | --- |
| 0 | Driver tick 1 writes the products-page snapshot card and two discovery cards. |
| 1 to 5 | The dispatcher claims the first ready card and spawns the Builder. `hermes kanban list` shows one card running. |
| 15 to 45 | The Builder requests review; the Critic passes or bounces it; the verdict appears on the status page. |
| 30 | Driver tick 2 writes the next cards. |
| 60 | Two to four cards done or in review. The ledger has two lines. |

If nothing has moved after an hour: `hermes -p hustle-reporter gateway status`, then `tail ~/project/harness/driver-tick.log` and `hermes kanban list --status blocked`. Paste what you see into the Claude session.
