import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const bot = read("bot.mjs");
const pkg = JSON.parse(read("package.json"));
const envExample = read(".env.example");

// ── Reads the same rare-roll feed the game uses ───────────────────────
assert.match(bot, /\.from\("global_chat_announcements"\)/);
for (const column of ["id", "player_id", "gem_name", "rarity", "effective_rarity", "mutation_ids", "luck_at_roll", "created_at"]) {
  assert.match(bot, new RegExp(`\\b${column}\\b`), `bot must select ${column}`);
}
// Incremental cursor: only fetch rolls newer than the last posted id.
assert.match(bot, /\.gt\("id", sinceId\)/);
// Usernames + mutation names come from the same public RPCs as in-game chat.
assert.match(bot, /rpc\("get_chat_profiles", \{ p_user_ids: ids \}\)/);
assert.match(bot, /rpc\("get_public_mutation_catalog"\)/);

// ── Read-only, least privilege ────────────────────────────────────────
assert.match(bot, /signInAnonymously\(\)/);
assert.doesNotMatch(bot, /service_role|SERVICE_ROLE/);
assert.doesNotMatch(bot, /\.(insert|update|delete|upsert)\(/);

// ── Posts to a Discord webhook ────────────────────────────────────────
assert.match(bot, /fetch\(DISCORD_WEBHOOK_URL/);
assert.match(bot, /embeds: \[embed\]/);
assert.match(bot, /=== 429/);

// ── First run doesn't replay the whole backlog ────────────────────────
assert.match(bot, /if \(!lastId\)[\s\S]*latestAnnouncementId\(\)/);
assert.match(bot, /oddsFor\(row\) >= minEffectiveRarity/);
// On a failed post, the cursor must not skip the undelivered roll.
assert.match(bot, /Failed to post roll[\s\S]*?return;/);

// ── Packaging ─────────────────────────────────────────────────────────
assert.equal(pkg.type, "module");
assert.equal(pkg.scripts.start, "node bot.mjs");
assert.ok(pkg.dependencies["@supabase/supabase-js"], "must depend on @supabase/supabase-js");
for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "DISCORD_WEBHOOK_URL"]) {
  assert.match(envExample, new RegExp(`^${key}=`, "m"), `.env.example must document ${key}`);
}

console.log("bot-test passed");
