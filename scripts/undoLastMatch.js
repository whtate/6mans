// scripts/undoLastMatch.js
const { Pool } = require('pg');
require('dotenv').config({ path: `${__dirname}/../.env` });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const [,, guildId, matchIdArg] = process.argv;
  if (!guildId) {
    console.error('Usage: node scripts/undoLastMatch.js <GUILD_ID> [MATCH_ID]');
    process.exit(1);
  }

  let matchId = matchIdArg;
  if (!matchId) {
    const { rows } = await pool.query(
      `SELECT id FROM matches WHERE guild_id=$1 ORDER BY id DESC LIMIT 1`,
      [guildId]
    );
    if (!rows.length) {
      console.error('No matches found for this guild.');
      process.exit(1);
    }
    matchId = rows[0].id;
  }

  console.log(`Undoing match ${matchId} for guild ${guildId}...`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: hist } = await client.query(
      `SELECT user_id, win, delta FROM mmr_history WHERE guild_id=$1 AND match_id=$2`,
      [guildId, matchId]
    );
    if (!hist.length) throw new Error('No mmr_history rows for that match.');

    for (const row of hist) {
      const { user_id, win, delta } = row;
      await client.query(
        `UPDATE players
           SET mmr = mmr - $1,
               wins = wins - $2,
               losses = losses - $3,
               streak = CASE
                 WHEN $4 = 1 THEN
                   CASE WHEN streak > 0 THEN streak - 1 ELSE streak END
                 ELSE
                   CASE WHEN streak < 0 THEN streak + 1 ELSE streak END
               END
         WHERE guild_id=$5 AND user_id=$6`,
        [delta, win ? 1 : 0, win ? 0 : 1, win ? 1 : 0, guildId, user_id]
      );
    }

    await client.query(`DELETE FROM mmr_history WHERE guild_id=$1 AND match_id=$2`, [guildId, matchId]);
    await client.query(`DELETE FROM matches WHERE guild_id=$1 AND id=$2`, [guildId, matchId]);

    await client.query('COMMIT');
    console.log('✅ Match undone.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Undo failed:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
