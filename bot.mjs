import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

// =========================================================
// GEM INCREMENTAL — RARE ROLL DISCORD BOT
//
// Watches the game's rare-roll feed and posts each new rare roll to a
// Discord channel via a webhook. Read-only: it calls the game's public
// `get_rare_roll_chat_history` RPC (the same one that powers the in-game
// rare-roll chat) with the public anon key — no login, no service-role
// key, no write path. That RPC already returns the roller's username, so
// the bot needs nothing else.
//
// No Discord bot token or gateway needed — it posts to a channel webhook.
// Configure with environment variables (see .env.example) and run
// `npm start`.
// =========================================================

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  DISCORD_WEBHOOK_URL,
  MIN_EFFECTIVE_RARITY = "0",
  POLL_SECONDS = "20",
  STATE_FILE = "./.rare-roll-cursor.json"
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !DISCORD_WEBHOOK_URL) {
  console.error("Missing config. Set SUPABASE_URL, SUPABASE_ANON_KEY and DISCORD_WEBHOOK_URL (see .env.example).");
  process.exit(1);
}

const minEffectiveRarity = Number(MIN_EFFECTIVE_RARITY) || 0;
const pollMs = Math.max(5, Number(POLL_SECONDS) || 20) * 1000;
// The feed RPC returns newest-first up to 200 rows; ample headroom between polls.
const FEED_LIMIT = 200;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

// Map of mutation id -> display name, loaded once at startup (best effort).
let mutationNames = {};

// -----------------------------------------------------------------
// Cursor: the highest roll id already posted. Persisted so a restart
// never re-posts old rolls.
// -----------------------------------------------------------------
function loadCursor() {
  try {
    return Number(JSON.parse(readFileSync(STATE_FILE, "utf8")).lastId) || 0;
  } catch {
    return 0;
  }
}

function saveCursor(lastId) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ lastId }));
  } catch (error) {
    console.error("Could not persist cursor:", error.message);
  }
}

// -----------------------------------------------------------------
// Supabase reads (public RPCs, anon key, read-only)
// -----------------------------------------------------------------
async function loadMutationNames() {
  const { data, error } = await supabase.rpc("get_public_mutation_catalog");
  if (error || !Array.isArray(data)) return;
  mutationNames = Object.fromEntries(data.map((m) => [String(m.id), m.name || String(m.id)]));
}

async function fetchFeed() {
  const { data, error } = await supabase.rpc("get_rare_roll_chat_history", { p_limit: FEED_LIMIT });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function latestRollId() {
  const { data, error } = await supabase.rpc("get_rare_roll_chat_history", { p_limit: 1 });
  if (error) throw error;
  return Number(data?.[0]?.id) || 0;
}

function newRollsSince(feed, sinceId) {
  return feed
    .filter((row) => Number(row.id) > sinceId)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

// -----------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------
function parseMutationIds(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch { /* legacy comma list */ }
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function oddsFor(row) {
  // effective_rarity already folds in mutation chances; fall back to base.
  const value = Number(row.effective_rarity) || Number(row.rarity) || 0;
  return Math.max(1, Math.round(value));
}

// Rarer rolls get a hotter colour, mirroring the in-game tiers loosely.
function colorFor(odds) {
  if (odds >= 1_000_000_000) return 0xffd166; // gold
  if (odds >= 100_000_000) return 0xef476f;   // red
  if (odds >= 10_000_000) return 0xa855f7;    // purple
  if (odds >= 1_000_000) return 0x3b82f6;     // blue
  return 0x8b95a8;                            // muted
}

function buildEmbed(row) {
  const username = row.username || "Someone";
  const odds = oddsFor(row);
  const mutations = parseMutationIds(row.mutation_ids).map((id) => mutationNames[id] || id);
  const fields = [
    { name: "Odds", value: `1 in ${odds.toLocaleString("en-US")}`, inline: true },
    { name: "Base rarity", value: `1 in ${Number(row.rarity || 0).toLocaleString("en-US")}`, inline: true }
  ];
  if (mutations.length) fields.push({ name: "Mutations", value: mutations.join(", "), inline: false });
  if (row.base_luck != null) {
    fields.push({ name: "Luck", value: `${Number(row.base_luck).toFixed(2)}×`, inline: true });
  }
  return {
    title: "💎 Rare roll!",
    description: `**${username}** rolled **${row.gem_name}** — 1 in ${odds.toLocaleString("en-US")}`,
    color: colorFor(odds),
    fields,
    timestamp: row.created_at || new Date().toISOString(),
    footer: { text: "Gem Incremental" }
  };
}

async function postToDiscord(embed) {
  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ embeds: [embed] })
  });
  // Discord rate-limits webhooks; back off politely if asked to.
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after")) || 1;
    await sleep(retry * 1000 + 250);
    return postToDiscord(embed);
  }
  if (!response.ok) {
    throw new Error(`Discord webhook returned ${response.status}: ${await response.text()}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------
let lastId = loadCursor();

async function tick() {
  const feed = await fetchFeed();
  const rolls = newRollsSince(feed, lastId);
  if (!rolls.length) return;

  for (const row of rolls) {
    if (oddsFor(row) >= minEffectiveRarity) {
      try {
        await postToDiscord(buildEmbed(row));
        await sleep(400); // stay well under Discord's webhook rate limit
      } catch (error) {
        console.error(`Failed to post roll #${row.id}:`, error.message);
        // Stop here so the cursor doesn't skip a roll we couldn't deliver;
        // the next tick retries from this id.
        return;
      }
    }
    lastId = Number(row.id);
    saveCursor(lastId);
  }
}

async function main() {
  await loadMutationNames();

  // First run with no saved cursor: start from the newest roll so the bot
  // reports rolls going forward instead of replaying the whole backlog.
  if (!lastId) {
    lastId = await latestRollId();
    saveCursor(lastId);
  }

  console.log(`Rare-roll bot live. Watching from roll #${lastId}, polling every ${pollMs / 1000}s, min odds 1 in ${minEffectiveRarity.toLocaleString("en-US")}.`);

  // Run forever; a single tick failure just logs and retries next interval.
  for (;;) {
    try {
      await tick();
    } catch (error) {
      console.error("Poll failed:", error.message);
    }
    await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
