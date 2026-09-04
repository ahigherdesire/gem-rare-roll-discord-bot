import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

// =========================================================
// GEM INCREMENTAL — RARE ROLL DISCORD BOT
//
// Watches the same `global_chat_announcements` feed that powers the
// in-game rare-roll chat and posts each new rare roll to a Discord
// channel via a webhook. Read-only: it signs in anonymously with the
// public anon key (exactly like the game client) and never touches the
// service-role key or any write path.
//
// No Discord bot token or gateway needed — a channel webhook is all it
// posts to. Configure with environment variables (see .env.example) and
// run `npm start`.
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

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: true }
});

// Map of mutation id -> display name, loaded once at startup.
let mutationNames = {};

// -----------------------------------------------------------------
// Cursor: the highest announcement id already posted. Persisted so a
// restart never re-posts old rolls.
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
// Supabase reads (anonymous, read-only)
// -----------------------------------------------------------------
async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw new Error(`Anonymous sign-in failed: ${error.message}`);
  }
}

async function loadMutationNames() {
  const { data, error } = await supabase.rpc("get_public_mutation_catalog");
  if (error || !Array.isArray(data)) return;
  mutationNames = Object.fromEntries(data.map((m) => [String(m.id), m.name || String(m.id)]));
}

async function latestAnnouncementId() {
  const { data, error } = await supabase
    .from("global_chat_announcements")
    .select("id")
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id ?? 0;
}

async function fetchNewRolls(sinceId) {
  const { data, error } = await supabase
    .from("global_chat_announcements")
    .select("id, player_id, gem_name, rarity, effective_rarity, mutation_ids, luck_at_roll, created_at")
    .gt("id", sinceId)
    .order("id", { ascending: true })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

async function fetchUsernames(playerIds) {
  const ids = [...new Set(playerIds.filter(Boolean))];
  if (!ids.length) return {};
  const { data, error } = await supabase.rpc("get_chat_profiles", { p_user_ids: ids });
  if (error || !data || typeof data !== "object") return {};
  return data;
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

function buildEmbed(row, username) {
  const odds = oddsFor(row);
  const mutations = parseMutationIds(row.mutation_ids).map((id) => mutationNames[id] || id);
  const fields = [
    { name: "Odds", value: `1 in ${odds.toLocaleString("en-US")}`, inline: true },
    { name: "Base rarity", value: `1 in ${Number(row.rarity || 0).toLocaleString("en-US")}`, inline: true }
  ];
  if (mutations.length) fields.push({ name: "Mutations", value: mutations.join(", "), inline: false });
  if (row.luck_at_roll != null) {
    fields.push({ name: "Luck", value: `${Number(row.luck_at_roll).toFixed(2)}×`, inline: true });
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
  await ensureSession();
  const rolls = await fetchNewRolls(lastId);
  if (!rolls.length) return;

  const profiles = await fetchUsernames(rolls.map((r) => r.player_id));

  for (const row of rolls) {
    if (oddsFor(row) >= minEffectiveRarity) {
      const username = profiles[row.player_id]?.username || "Someone";
      try {
        await postToDiscord(buildEmbed(row, username));
        await sleep(400); // stay well under Discord's webhook rate limit
      } catch (error) {
        console.error(`Failed to post roll #${row.id}:`, error.message);
        // Stop here so the cursor doesn't skip a roll we couldn't deliver;
        // the next tick retries from this id.
        return;
      }
    }
    lastId = row.id;
    saveCursor(lastId);
  }
}

async function main() {
  await ensureSession();
  await loadMutationNames();

  // First run with no saved cursor: start from the newest roll so the bot
  // reports rolls going forward instead of replaying the whole backlog.
  if (!lastId) {
    lastId = await latestAnnouncementId();
    saveCursor(lastId);
  }

  console.log(`Rare-roll bot live. Watching from announcement #${lastId}, polling every ${pollMs / 1000}s, min odds 1 in ${minEffectiveRarity.toLocaleString("en-US")}.`);

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
