# Rare Roll Discord Bot

Posts Gem Incremental **rare rolls** to a Discord channel. It watches the same
`global_chat_announcements` feed that drives the in-game rare-roll chat, so it
reports exactly the rolls the game already considers rare (big base rarity, or
mutation-driven effective rarity over the announcement threshold).

It is **read-only** and needs no Discord bot token — it posts through a channel
**webhook**, and reads the game's public `get_rare_roll_chat_history` RPC with the
public anon key (the same values the website ships). No login is required; that
RPC already returns the roller's username. It never uses the service-role key or
any write path.

## Setup

1. **Create a Discord webhook**
   In your server: *Channel → Edit Channel → Integrations → Webhooks → New
   Webhook*, pick the channel, and **Copy Webhook URL**.

2. **Configure**
   ```bash
   cd discord-rare-roll-bot
   cp .env.example .env
   # fill in SUPABASE_URL, SUPABASE_ANON_KEY (public anon key) and
   # DISCORD_WEBHOOK_URL
   ```
   `SUPABASE_URL` and the anon key are the game's **public** client values
   (the same ones shipped in the website's `src/backend/supabase.js`) — the
   anon/publishable key, never the service-role key.

3. **Install & run**
   ```bash
   npm install
   npm start
   ```
   Requires **Node 22+** (`@supabase/supabase-js` needs the native global
   `WebSocket`, and the bot uses the built-in `fetch`).

On first start (no saved cursor) the bot begins from the newest announcement, so
it only reports rolls **going forward** — it won't replay the whole backlog. The
last posted roll id is persisted to `STATE_FILE`, so restarts pick up where they
left off.

## Options

| Env var | Default | Purpose |
| --- | --- | --- |
| `MIN_EFFECTIVE_RARITY` | `0` | Only post rolls at or above these odds (1 in N). `0` posts every roll the game already deems rare; set e.g. `100000000` for 1-in-100M+ only. |
| `POLL_SECONDS` | `20` | How often to check for new rolls (minimum 5). |
| `STATE_FILE` | `./.rare-roll-cursor.json` | Where the "last posted roll" cursor is stored. |

## Running it long-term

It's a plain long-running Node process — on your own machine use **pm2**
(`pm2 start bot.mjs --name rare-roll-bot && pm2 save && pm2 startup`) or a
**systemd** unit. But that only runs while your computer is on.

### Deploy to a free host (always-on)

The repo is container-ready (`Dockerfile`) and exposes a health port, so it fits
the free tiers that need one. **Never commit `.env`** — set the three values as
the host's secrets/environment variables instead:
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DISCORD_WEBHOOK_URL`.

**Fly.io** (no GitHub needed; a small machine stays on within the free
allowance). Install [flyctl](https://fly.io/docs/flyctl/install/), then from this
folder:

```bash
fly auth login
fly launch --no-deploy          # accept the app name; keep the existing fly.toml
fly secrets set \
  SUPABASE_URL="https://YOUR-PROJECT.supabase.co" \
  SUPABASE_ANON_KEY="your-public-anon-key" \
  DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
fly deploy
fly scale count 1               # ensure exactly one always-on machine
fly logs                        # should show "Rare-roll bot live..."
```

**Railway / Koyeb / Render** (deploy from GitHub): push this repo to GitHub, then
in the host create a new project **from the repo**. It builds the `Dockerfile`
automatically. Add the three environment variables in the dashboard. On Railway
pick a **Worker** (or Web) service; on Koyeb/Render a **Web Service** (the health
port satisfies the check). Avoid tiers that sleep on idle — a poller must stay
awake (Fly and Koyeb's free instances stay on; Render's free **web** service
sleeps, so use a background worker there or a different host).

State note: the `.rare-roll-cursor.json` cursor lives on the host's disk. On
platforms with ephemeral disks a redeploy resets it, which just means the bot
resumes from the newest roll at that moment — never a flood of old rolls.

## Notes

- Rolls (with usernames) come from the public `get_rare_roll_chat_history` RPC and
  mutation names from `get_public_mutation_catalog` — the same sources the in-game
  chat uses.
- Everything it posts (username, gem, odds) is already public in the game's
  global rare-roll chat.
- Prefer a full gateway bot (slash commands, reactions)? Swap the webhook POST
  for `discord.js`; the Supabase read logic stays the same.
