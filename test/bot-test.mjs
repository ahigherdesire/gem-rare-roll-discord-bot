import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const bot = read("bot.mjs");
const pkg = JSON.parse(read("package.json"));
const envExample = read(".env.example");

// ── Reads the game's public rare-roll feed ────────────────────────────
// One public RPC returns id + username + gem + rarity + effective_rarity
// + mutations, so no table access or login is needed.
assert.match(bot, /rpc\("get_rare_roll_chat_history", \{ p_limit: FEED_LIMIT \}\)/);
assert.match(bot, /rpc\("get_public_mutation_catalog"\)/);
for (const field of ["id", "username", "gem_name", "rarity", "effective_rarity", "mutation_ids", "base_luck", "created_at"]) {
  assert.match(bot, new RegExp(`\\brow\\.${field}\\b`), `bot must use row.${field}`);
}
// Incremental cursor: only post rolls newer than the last posted id.
assert.match(bot, /Number\(row\.id\) > sinceId/);

// ── Read-only, least privilege ────────────────────────────────────────
// No login needed, no service-role key, no writes, no direct table access.
assert.doesNotMatch(bot, /service_role|SERVICE_ROLE/);
assert.doesNotMatch(bot, /\.(insert|update|delete|upsert)\(/);
assert.doesNotMatch(bot, /\.from\(/, "should read via public RPC, not tables");

// ── Posts to a Discord webhook ────────────────────────────────────────
assert.match(bot, /fetch\(DISCORD_WEBHOOK_URL/);
assert.match(bot, /embeds: \[embed\]/);
assert.match(bot, /=== 429/);

// ── First run doesn't replay the whole backlog ────────────────────────
assert.match(bot, /if \(!lastId\)[\s\S]*latestRollId\(\)/);
assert.match(bot, /oddsFor\(row\) >= minEffectiveRarity/);
// On a failed post, the cursor must not skip the undelivered roll.
assert.match(bot, /Failed to post roll[\s\S]*?return;/);

// ── Deployability ─────────────────────────────────────────────────────
// A health port so free hosts that require one don't kill the poller.
assert.match(bot, /createServer\(/);
assert.match(bot, /Number\(process\.env\.PORT\) \|\| 8080/);
// Container-ready for the free hosts.
assert.ok(fs.existsSync(new URL("../Dockerfile", import.meta.url)), "Dockerfile must exist for container hosts");

// ── Packaging ─────────────────────────────────────────────────────────
assert.equal(pkg.type, "module");
assert.equal(pkg.scripts.start, "node bot.mjs");
assert.ok(pkg.dependencies["@supabase/supabase-js"], "must depend on @supabase/supabase-js");
assert.ok(pkg.dependencies["dotenv"], "must depend on dotenv to load .env");
for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "DISCORD_WEBHOOK_URL"]) {
  assert.match(envExample, new RegExp(`^${key}=`, "m"), `.env.example must document ${key}`);
}

console.log("bot-test passed");
