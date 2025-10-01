// scripts/backfillPlayersFromHistory.js
// Usage:
//   node scripts/backfillPlayersFromHistory.js                 # all guilds
//   node scripts/backfillPlayersFromHistory.js <GUILD_ID>     # one guild
//
// Recomputes players.mmr/wins/losses/streak from mmr_history.
// Base rating = 1000 + sum(delta).
//
// Requires DATABASE_URL (and SSL) in your .env like the bot.

const { Pool } = require('pg');
require('dotenv').config({ path: `${__dirname}/../.env` });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function backfillOneGuild(guildId) {
  console.log(`\n--- Backfilling guild: ${guildId} ---`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Ensure a players row exists for every user found in mmr_history
    const { rows: users } = await client.query(
      `SELECT DISTINCT user_id FROM mmr_history WHERE guild_id=$1`,
      [guildId]
    );

    for (const u of users) {
      await client.query(
        `INSERT INTO players (guild_id, user_id, username)
         VALUES ($1,$2,COALESCE(
           (SELECT username FROM players WHERE guild_id=$1 AND user_id=$2),
           $2
         ))
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
        [guildId, u.user_id]
      );
    }

    // 2) Recompute per-user stats from history
    const { rows: stats } = await client.query(
      `WITH agg AS (
         SELECT
           user_id,
           SUM(CASE WHEN win THEN 1 ELSE 0 END)::int AS wins,
           SUM(CASE WHEN win THEN 0 ELSE 1 END)::int AS losses,
           COALESCE(SUM(delta),0)::int AS sum_delta
         FROM mmr_history
         WHERE guild_id=$1
         GROUP BY user_id
       )
       SELECT p.user_id,
              COALESCE(a.wins,0) AS wins,
              COALESCE(a.losses,0) AS losses,
              1000 + COALESCE(a.sum_delta,0) AS mmr
       FROM players p
       LEFT JOIN agg a ON a.user_id = p.user_id
       WHERE p.guild_id=$1`,
      [guildId]
    );

    // 3) Compute streak from history: walk matches in chronological order
    const { rows: chron } = await client.query(
      `SELECT user_id, win
         FROM mmr_history
        WHERE guild_id=$1
        ORDER BY created_at ASC, id ASC`,
      [guildId]
    );

    const streakMap = new Map(); // userId -> streak int
    for (const r of chron) {
      const prev = streakMap.get(r.user_id) || 0;
      let next;
      if (r.win) next = prev >= 0 ? prev + 1 : 1;
      else       next = prev <= 0 ? prev - 1 : -1;
      streakMap.set(r.user_id, next);
    }

    // 4) Apply recomputed MMR/W/L/Streak into players
    for (const s of stats) {
      const streak = streakMap.get(s.user_id) || 0;
      await client.query(
        `UPDATE players
           SET mmr=$1, wins=$2, losses=$3, streak=$4
         WHERE guild_id=$5 AND user_id=$6`,
        [s.mmr, s.wins, s.losses, streak, guildId, s.user_id]
      );
    }

    await client.query('COMMIT');
    console.log(`✅ Backfill complete for guild ${guildId}. Updated ${stats.length} players.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Backfill failed for', guildId, e);
  } finally {
    client.release();
  }
}

async function main() {
  const [, , onlyGuildId] = process.argv;

  if (onlyGuildId) {
    await backfillOneGuild(onlyGuildId);
  } else {
    // Run for all guilds we’ve seen in history
    const { rows } = await pool.query(`SELECT DISTINCT guild_id FROM mmr_history`);
    if (!rows.length) {
      console.log('No mmr_history rows found. Nothing to backfill.');
      return;
    }
    for (const r of rows) {
      await backfillOneGuild(r.guild_id);
    }
  }

  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
