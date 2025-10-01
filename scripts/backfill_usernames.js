// scripts/backfill_usernames.js
// Backfills players.username from Discord so leaderboards stop showing numeric IDs.
// Usage: node scripts/backfill_usernames.js <GUILD_ID>
// Env needed: token, DATABASE_URL
//
// Works with discord.js v11 (current codebase style).

require('dotenv').config({ path: `${__dirname}/../.env` })
const Discord = require('discord.js')
const { Pool } = require('pg')

const TOKEN = process.env.token || process.env.TOKEN
const DATABASE_URL = process.env.DATABASE_URL
const GUILD_ID = process.argv[2] || process.env.GUILD_ID

if (!TOKEN) {
  console.error('Missing token in env.')
  process.exit(1)
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in env.')
  process.exit(1)
}
if (!GUILD_ID) {
  console.error('Usage: node scripts/backfill_usernames.js <GUILD_ID>')
  process.exit(1)
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

async function getPlayers(guildId) {
  const { rows } = await pool.query(
    `SELECT user_id, username FROM players WHERE guild_id = $1 ORDER BY user_id`,
    [guildId]
  )
  return rows
}

async function updateUsername(guildId, userId, username) {
  await pool.query(
    `UPDATE players SET username = $1 WHERE guild_id = $2 AND user_id = $3`,
    [username, guildId, userId]
  )
}

function looksNumericUsername(s) {
  return !s || /^\d{16,}$/.test(String(s))
}

async function main() {
  console.log('Connecting to Discord…')

  const client = new Discord.Client()

  client.on('ready', async () => {
    try {
      console.log(`Logged in as ${client.user.username} (${client.user.id})`)
      const guild = client.guilds.get(GUILD_ID)
      if (!guild) {
        console.error(`Bot is not in guild ${GUILD_ID} or cannot access it.`)
        process.exit(1)
      }

      console.log(`Fetching players for guild ${GUILD_ID}…`)
      const players = await getPlayers(GUILD_ID)
      console.log(`Found ${players.length} player rows.`)

      let fixed = 0
      for (const p of players) {
        const { user_id, username } = p
        if (!looksNumericUsername(username)) continue

        // Try cache then fetchMember (v11)
        let mem = guild.members.get(user_id)
        if (!mem && guild.fetchMember) {
          try { mem = await guild.fetchMember(user_id) } catch (_) {}
        }

        let finalName = null
        if (mem && mem.user && mem.user.username) {
          finalName = mem.user.username
        } else {
          // Fallback: client.fetchUser in v11
          try {
            if (typeof client.fetchUser === 'function') {
              const u = await client.fetchUser(user_id)
              if (u && u.username) finalName = u.username
            }
          } catch (_) {}
        }

        if (finalName && finalName !== username) {
          await updateUsername(GUILD_ID, user_id, finalName)
          fixed++
          console.log(`Updated ${user_id} -> ${finalName}`)
        }
      }

      console.log(`Done. Updated ${fixed} usernames.`)
    } catch (e) {
      console.error('Backfill failed:', e)
    } finally {
      try { await pool.end() } catch {}
      client.destroy()
      process.exit(0)
    }
  })

  client.on('error', (e) => console.error('Discord client error:', e))
  client.login(TOKEN).catch((e) => {
    console.error('Login failed:', e)
    process.exit(1)
  })
}

main()
