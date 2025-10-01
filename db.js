// db.js
const { Pool } = require('pg');
require('dotenv').config({ path: `${__dirname}/.env` });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      guild_id   text NOT NULL,
      user_id    text NOT NULL,
      username   text NOT NULL,
      mmr        int  NOT NULL DEFAULT 1000,
      wins       int  NOT NULL DEFAULT 0,
      losses     int  NOT NULL DEFAULT 0,
      streak     int  NOT NULL DEFAULT 0, -- positive=win streak, negative=loss streak
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS mmr_history (
      id         serial PRIMARY KEY,
      guild_id   text NOT NULL,
      user_id    text NOT NULL,
      match_id   int  NOT NULL,
      win        boolean NOT NULL,
      delta      int  NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS matches (
      id              serial PRIMARY KEY,
      guild_id        text NOT NULL,
      winner          char(1) NOT NULL CHECK (winner IN ('A','B')),
      team_a          jsonb NOT NULL,   -- array of user IDs
      team_b          jsonb NOT NULL,   -- array of user IDs
      lobby_name      text,
      lobby_region    text,
      lobby_series    int,
      reporter_user_id text NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Make sure streak column exists on older tables
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS streak int NOT NULL DEFAULT 0;`);
}

async function upsertPlayer({ guildId, userId, username }) {
  await pool.query(
    `INSERT INTO players (guild_id, user_id, username)
     VALUES ($1,$2,$3)
     ON CONFLICT (guild_id, user_id)
     DO UPDATE SET username = EXCLUDED.username`,
    [guildId, userId, username]
  );
}

async function getStats({ guildId, userId }) {
  // Lifetime
  const { rows } = await pool.query(
    `SELECT username, mmr, wins, losses
       FROM players
      WHERE guild_id=$1 AND user_id=$2`,
    [guildId, userId]
  );
  const life = rows[0] || null;

  // This month (from the 1st)
  const { rows: m } = await pool.query(
    `SELECT
        COALESCE(SUM(CASE WHEN win THEN 1 ELSE 0 END),0)::int AS wins,
        COALESCE(SUM(CASE WHEN win THEN 0 ELSE 1 END),0)::int AS losses,
        COALESCE(SUM(delta),0)::int AS mmr_delta
     FROM mmr_history
     WHERE guild_id=$1
       AND user_id=$2
       AND created_at >= date_trunc('month', now())`,
    [guildId, userId]
  );
  const month = m[0];

  return { life, month };
}

async function getLeaderboard({ guildId, limit = 10 }) {
  const { rows } = await pool.query(
    `WITH month_stats AS (
       SELECT user_id,
              SUM(CASE WHEN win THEN 1 ELSE 0 END)::int AS wins,
              SUM(CASE WHEN win THEN 0 ELSE 1 END)::int AS losses,
              SUM(delta)::int AS mmr_delta
       FROM mmr_history
       WHERE guild_id=$1
         AND created_at >= date_trunc('month', now())
       GROUP BY user_id
     )
     SELECT p.username,
            p.user_id,
            COALESCE(ms.wins,0)   AS month_wins,
            COALESCE(ms.losses,0) AS month_losses,
            COALESCE(ms.mmr_delta,0) AS month_mmr_delta,
            p.mmr AS lifetime_mmr
     FROM players p
     LEFT JOIN month_stats ms ON ms.user_id = p.user_id
     WHERE p.guild_id=$1
     ORDER BY COALESCE(ms.wins,0) DESC,
              COALESCE(ms.mmr_delta,0) DESC,
              p.mmr DESC
     LIMIT $2`,
    [guildId, limit]
  );
  return rows;
}

// ---------- Elo utilities with underdog & streak scaling ----------

function logisticExpected(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

/**
 * Compute team-level K scaling:
 * - baseK: 24
 * - underdog bonus: up to +50% if a large upset (uses avg rating diff & actual winner)
 * - favorite penalty: as low as -33% for huge mismatch wins
 * - streak bonus: +5% per average winner streak step (streak>=2), capped at +20%
 */
function teamK(baseK, avgA, avgB, winner, avgWinStreak) {
  const diff = (winner === 'A') ? (avgB - avgA) : (avgA - avgB); // >0 if winner was underdog
  const undBonus  = Math.max(0, Math.min(0.5, diff / 800));   // +0..+0.5
  const favPenalty = Math.max(-0.33, Math.min(0, diff / -1200)); // 0..-0.33
  const streakSteps = Math.max(0, avgWinStreak - 1);
  const streakBonus = Math.min(0.20, 0.05 * streakSteps);
  const scale = 1 + undBonus + favPenalty + streakBonus;
  return Math.max(8, Math.round(baseK * scale)); // never below 8
}

function eloTeamDelta(avgA, avgB, winner, KA = 24, KB = 24) {
  const expA = logisticExpected(avgA, avgB);
  const scoreA = winner === 'A' ? 1 : 0;
  const deltaA = Math.round(KA * (scoreA - expA));
  const deltaB = -Math.round(KB * (scoreA - expA));
  return { deltaA, deltaB };
}

/**
 * Record a result and store lobby+reporter info.
 * Applies underdog & streak scaling and updates streaks.
 */
async function recordResult({
  guildId, teamAIds, teamBIds, winner, reporterUserId,
  lobbyName, lobbyRegion, lobbySeries
}) {
  if (!['A','B'].includes(winner)) throw new Error('winner must be A or B');
  const ids = [...teamAIds, ...teamBIds];

  // fetch players' mmr and streak
  const { rows } = await pool.query(
    `SELECT user_id, mmr, streak FROM players
      WHERE guild_id=$1 AND user_id = ANY($2)`,
    [guildId, ids]
  );
  const info = Object.fromEntries(rows.map(r => [r.user_id, { mmr: r.mmr, streak: r.streak }]));

  const avgA = teamAIds.reduce((s,id)=>s+(info[id]?.mmr ?? 1000),0)/teamAIds.length;
  const avgB = teamBIds.reduce((s,id)=>s+(info[id]?.mmr ?? 1000),0)/teamBIds.length;

  const winStreaks = (winner === 'A' ? teamAIds : teamBIds).map(id => info[id]?.streak ?? 0);
  const avgWinStreak = winStreaks.reduce((a,b)=>a+b,0) / winStreaks.length;

  const baseK = 24;
  const KA = teamK(baseK, avgA, avgB, winner, avgWinStreak);
  const KB = teamK(baseK, avgB, avgA, winner === 'A' ? 'B' : 'A', avgWinStreak);
  const { deltaA, deltaB } = eloTeamDelta(avgA, avgB, winner, KA, KB);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: mrow } = await client.query(
      `INSERT INTO matches (guild_id, winner, team_a, team_b, lobby_name, lobby_region, lobby_series, reporter_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, created_at`,
      [guildId, winner, JSON.stringify(teamAIds), JSON.stringify(teamBIds), lobbyName || null, lobbyRegion || null, lobbySeries || null, reporterUserId]
    );
    const matchId = mrow[0].id;

    const q = `UPDATE players
               SET mmr = mmr + $1,
                   wins = wins + $2,
                   losses = losses + $3,
                   streak = $4
               WHERE guild_id = $5 AND user_id = $6`;

    const winIds = winner === 'A' ? teamAIds : teamBIds;
    const loseIds = winner === 'A' ? teamBIds : teamAIds;
    const winDelta = winner === 'A' ? deltaA : deltaB;
    const loseDelta = winner === 'A' ? deltaB : deltaA;

    for (const id of winIds) {
      const prev = info[id]?.streak ?? 0;
      const nextStreak = (prev >= 0 ? prev + 1 : 1);
      await client.query(q, [winDelta, 1, 0, nextStreak, guildId, id]);
      await client.query(
        `INSERT INTO mmr_history (guild_id, user_id, match_id, win, delta)
         VALUES ($1,$2,$3,$4,$5)`,
        [guildId, id, matchId, true, winDelta]
      );
    }
    for (const id of loseIds) {
      const prev = info[id]?.streak ?? 0;
      const nextStreak = (prev <= 0 ? prev - 1 : -1);
      await client.query(q, [loseDelta, 0, 1, nextStreak, guildId, id]);
      await client.query(
        `INSERT INTO mmr_history (guild_id, user_id, match_id, win, delta)
         VALUES ($1,$2,$3,$4,$5)`,
        [guildId, id, matchId, false, loseDelta]
      );
    }

    await client.query('COMMIT');
    return { matchId, deltaA, deltaB, KA, KB, avgA, avgB, createdAt: mrow[0].created_at };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Undo a match by id (one-off admin script uses this internally)
 */
async function undoMatch({ guildId, matchId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: hist } = await client.query(
      `SELECT user_id, win, delta
         FROM mmr_history
        WHERE guild_id=$1 AND match_id=$2`,
      [guildId, matchId]
    );
    if (hist.length === 0) throw new Error('No history found for this match in this guild.');

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
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------- NEW: History queries for lobby/user/last ----------

async function getLobbyHistory({ guildId, lobbyName, limit = 10 }) {
  // Support passing just "Lobby #2" by expanding with your brand
  const BRAND = process.env.lobbyName || 'in-house 6mans'
  let name = lobbyName ? lobbyName.trim() : null
  let useLike = false

  if (name) {
    // If they typed only "Lobby #X", expand to "Brand — Lobby #X"
    if (/^lobby\s*#\d+$/i.test(name)) {
      name = `${BRAND} — ${name}`
    } else if (!name.includes('—') && !name.toLowerCase().includes(BRAND.toLowerCase())) {
      // If it's a partial (doesn’t include brand), fall back to ILIKE %name%
      useLike = true
      name = `%${name}%`
    }
  }

  if (name) {
    const text = `
      SELECT id, winner, team_a, team_b, lobby_name, lobby_region, lobby_series, reporter_user_id, created_at
      FROM matches
      WHERE guild_id=$1
        AND ${useLike ? 'lobby_name ILIKE $2' : 'lobby_name = $2'}
      ORDER BY id DESC
      LIMIT $3
    `
    const params = [guildId, name, limit]
    const { rows } = await pool.query(text, params)
    return rows
  } else {
    const text = `
      SELECT id, winner, team_a, team_b, lobby_name, lobby_region, lobby_series, reporter_user_id, created_at
      FROM matches
      WHERE guild_id=$1
      ORDER BY id DESC
      LIMIT $2
    `
    const params = [guildId, limit]
    const { rows } = await pool.query(text, params)
    return rows
  }
}


async function getUserHistory({ guildId, userId, limit = 10 }) {
  const { rows } = await pool.query(
    `SELECT m.id, m.winner, m.team_a, m.team_b, m.lobby_name, m.lobby_region, m.lobby_series, m.reporter_user_id, m.created_at,
            (SELECT SUM(delta) FROM mmr_history h WHERE h.guild_id=m.guild_id AND h.match_id=m.id AND h.user_id=$2) AS user_delta,
            (SELECT BOOL_OR(win) FROM mmr_history h WHERE h.guild_id=m.guild_id AND h.match_id=m.id AND h.user_id=$2) AS user_win
       FROM matches m
      WHERE m.guild_id=$1
        AND ( $2 = ANY(SELECT jsonb_array_elements_text(m.team_a))
           OR $2 = ANY(SELECT jsonb_array_elements_text(m.team_b)) )
      ORDER BY m.id DESC
      LIMIT $3`,
    [guildId, userId, limit]
  );
  return rows;
}

async function getLastMatches({ guildId, limit = 5 }) {
  const { rows } = await pool.query(
    `SELECT id, winner, team_a, team_b, lobby_name, lobby_region, lobby_series, reporter_user_id, created_at
       FROM matches
      WHERE guild_id=$1
      ORDER BY id DESC
      LIMIT $2`,
    [guildId, limit]
  );
  return rows;
}

/* ===========================
   NEW HELPERS (non-breaking)
   =========================== */

/**
 * Apply a sub-out penalty (e.g., -15 MMR) and record it in mmr_history.
 * Uses match_id = 0 to indicate a system adjustment, not a real match row.
 *
 * @param {Object} params
 * @param {string} params.guildId
 * @param {string} params.subOutUserId
 * @param {number} [params.amount=15] positive number; will be subtracted from MMR
 */
async function applySubPenalty({ guildId, subOutUserId, amount = 15 }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Deduct MMR
    await client.query(
      `UPDATE players SET mmr = mmr - $1 WHERE guild_id=$2 AND user_id=$3`,
      [amount, guildId, subOutUserId]
    );
    // Record an auditable history row
    await client.query(
      `INSERT INTO mmr_history (guild_id, user_id, match_id, win, delta)
       VALUES ($1,$2,$3,$4,$5)`,
      [guildId, subOutUserId, 0, false, -amount]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Delete players from the database who are no longer in the guild.
 * Pass the list of user IDs that are still present; everyone else is pruned.
 *
 * @param {Object} params
 * @param {string} params.guildId
 * @param {string[]} params.aliveIds
 * @returns {number} count of deleted rows
 */
async function pruneUsersNotIn({ guildId, aliveIds }) {
  if (!Array.isArray(aliveIds)) throw new Error('aliveIds must be an array of user IDs');
  const { rows } = await pool.query(
    `SELECT user_id FROM players WHERE guild_id=$1`,
    [guildId]
  );
  const keep = new Set(aliveIds);
  const stale = rows.map(r => r.user_id).filter(id => !keep.has(id));
  if (stale.length === 0) return 0;
  await pool.query(
    `DELETE FROM players WHERE guild_id=$1 AND user_id = ANY($2)`,
    [guildId, stale]
  );
  return stale.length;
}

module.exports = {
  pool,
  init,
  upsertPlayer,
  getStats,
  getLeaderboard,
  recordResult,
  undoMatch,
  getLobbyHistory,
  getUserHistory,
  getLastMatches,
  // NEW exports
  applySubPenalty,
  pruneUsersNotIn,
};
