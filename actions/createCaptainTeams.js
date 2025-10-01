// actions/createCaptainTeams.js
// Reaction-based captain draft in DMs, with per-player scouting cards.
// v11 DM fix: use a compat user fetcher (client.users.get or client.fetchUser)
// Adds explicit "queue expired" banner on 7-minute pick timeouts.
// Creates voice channels when teams finalize.

const { getStats, upsertPlayer } = require('../db')
const createVoiceChannels = require('./createVoiceChannels')

// 7 minutes per pick step (user request)
const PICK_TIMEOUT_MS = 7 * 60 * 1000

const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'] // supports up to 4 draft-eligible

function randInt(n) { return Math.floor(Math.random() * n) }
function fmtDelta(n) { const v = Number(n) || 0; return `${v >= 0 ? '+' : ''}${v}` }

// ----- v11-compatible user fetch -----
async function fetchUserCompat(client, id) {
  // v11: client.users.get(id) exists; client.fetchUser(id) fetches from API.
  try {
    if (client.users && typeof client.users.get === 'function') {
      const u = client.users.get(id)
      if (u) return u
    }
  } catch (_) {}
  try {
    if (typeof client.fetchUser === 'function') {
      const u = await client.fetchUser(id)
      if (u) return u
    }
  } catch (_) {}
  // v12+ fallback if the project ever upgrades
  try {
    if (client.users?.cache?.get) {
      const u = client.users.cache.get(id)
      if (u) return u
    }
  } catch (_) {}
  try {
    if (client.users?.fetch) {
      const u = await client.users.fetch(id)
      if (u) return u
    }
  } catch (_) {}
  return null
}

async function statsLine(guildId, userId, fallbackName) {
  let mmr = 1000, w = 0, l = 0, month = 0
  try {
    const s = await getStats({ guildId, userId })
    if (s?.life) {
      mmr = s.life.mmr ?? 1000
      w   = s.life.wins ?? 0
      l   = s.life.losses ?? 0
    }
    if (s?.month) month = s.month.mmr_delta ?? 0
  } catch (_) {}
  return { mmr, w, l, month, name: fallbackName }
}

async function buildScoutingCard(guild, candidates) {
  const guildId = guild?.id
  const lines = []
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i]
    let uname = p.username || null
    try {
      const mem = guild?.members?.cache?.get?.(p.id)
                || (guild?.members?.fetch ? await guild.members.fetch(p.id).catch(()=>null) : null)
      uname = mem?.user?.username || uname || String(p.id)
    } catch (_) {
      uname = uname || String(p.id)
    }
    try { await upsertPlayer({ guildId, userId: p.id, username: uname }) } catch {}
    const s = await statsLine(guildId, p.id, uname)
    lines.push(`**${i + 1}.** <@${p.id}> — MMR **${s.mmr}** — W/L **${s.w}/${s.l}** — ΔMMR (mo) **${fmtDelta(s.month)}**`)
  }
  return lines
}

async function sendPickDM({ user, header, guild, candidates }) {
  const lines = await buildScoutingCard(guild, candidates)
  const dm = await user.createDM()
  const body =
    `${header}\n\n` +
    `**Draft-Eligible Players**\n` +
    lines.join('\n') + '\n\n' +
    (candidates.length >= 2
      ? `React with the appropriate numbers within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes.`
      : `React with the number within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes.`)

  const msg = await dm.send(body)

  // react with available indices
  for (let i = 0; i < Math.min(candidates.length, NUM_EMOJI.length); i++) {
    // eslint-disable-next-line no-await-in-loop
    await msg.react(NUM_EMOJI[i])
  }

  return msg
}

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel
  const guild   = eventObj.guild
  const client  = require('../index') // your Discord.Client from index.js

  // normalize
  queue.players = (queue.players || []).filter(Boolean)
  queue.teams   = queue.teams || { blue: { players: [] }, orange: { players: [] } }

  // pick captains randomly
  const pool = [...queue.players]
  const blueCap   = pool.splice(randInt(pool.length), 1)[0]
  const orangeCap = pool.splice(randInt(pool.length), 1)[0]

  queue.teams.blue.captain   = blueCap
  queue.teams.orange.captain = orangeCap
  queue.teams.blue.players.push(blueCap)
  queue.teams.orange.players.push(orangeCap)

  // init draft state so !status can show who's picking
  queue.draft = {
    mode: 'captains',
    currentPicker: null, // 'blue' | 'orange' | null
    captains: { blue: blueCap.id, orange: orangeCap.id },
    unpicked: pool.map(p => p.id)
  }

  await channel.send({
    embed: {
      color: 2201331,
      title: 'Captain structure',
      fields: [
        { name: 'Captain Blue', value: `<@${blueCap.id}>`, inline: true },
        { name: 'Captain Orange', value: `<@${orangeCap.id}>`, inline: true },
      ],
    }
  })

  // Resolve users via v11-compatible fetch to ensure DMs can be sent
  const blueUser   = await fetchUserCompat(client, blueCap.id)
  const orangeUser = await fetchUserCompat(client, orangeCap.id)

  if (!blueUser || !orangeUser) {
    await channel.send('Could not DM captains (couldn’t fetch user objects). Ask them to enable DMs or ensure the bot can fetch users.')
    queue.draft.currentPicker = null
    return
  }

  // randomize who picks first
  const first = Math.random() < 0.5 ? 'blue' : 'orange'
  const second = first === 'blue' ? 'orange' : 'blue'
  queue.draft.currentPicker = first

  const emojiToIndex = Object.fromEntries(NUM_EMOJI.map((e, i) => [e, i + 1]))

  // ---------- FIRST PICK (1) via DM ----------
  const firstUser = first === 'blue' ? blueUser : orangeUser
  let firstMsg
  try {
    firstMsg = await sendPickDM({ user: firstUser, header: `You have **first pick** for **${queue?.lobby?.name || 'Lobby'}**.`, guild, candidates: pool })
  } catch (e) {
    await channel.send(`<@${firstUser.id}> I could not DM you. Please enable DMs from server members and try again.`)
    queue.draft.currentPicker = null
    return
  }

  const firstCollector = firstMsg.createReactionCollector(
    (r, u) => u.id === firstUser.id && emojiToIndex[r.emoji.name] && emojiToIndex[r.emoji.name] <= pool.length,
    { time: PICK_TIMEOUT_MS }
  )

  const firstResult = await new Promise((resolve) => {
    firstCollector.on('collect', (r) => {
      firstCollector.stop('picked')
      resolve(emojiToIndex[r.emoji.name] - 1) // 0-based index
    })
    firstCollector.on('end', async (_, reason) => {
      if (reason !== 'picked') resolve(null)
    })
  })

  if (firstResult == null) {
    // Mark expired & announce loudly in queue channel
    queue.draft.currentPicker = null
    queue.status = 'expired'
    queue.expiresAt = new Date().toISOString()
    await channel.send({
      embed: {
        color: 15158332,
        title: `Lobby ${queue?.lobby?.name || 'Lobby'} — Queue expired`,
        description: `No pick received within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes. The queue has been **disbanded**.`
      }
    })
    const { deletePlayerQueue } = require('../utils/managePlayerQueues')
    deletePlayerQueue(queue.lobby.id)
    return
  }

  const firstPickPlayer = pool.splice(firstResult, 1)[0]
  queue.teams[first].players.push(firstPickPlayer)
  queue.draft.unpicked = pool.map(p => p.id)

  // ---------- SECOND PICK (2) via DM ----------
  queue.draft.currentPicker = second
  const secondUser = second === 'blue' ? blueUser : orangeUser
  let secondMsg
  try {
    secondMsg = await sendPickDM({ user: secondUser, header: `You have **two picks** for **${queue?.lobby?.name || 'Lobby'}**.`, guild, candidates: pool })
  } catch (e) {
    await channel.send(`<@${secondUser.id}> I could not DM you. Please enable DMs from server members and try again.`)
    queue.draft.currentPicker = null
    return
  }

  const secondCollector = secondMsg.createReactionCollector(
    (r, u) => u.id === secondUser.id && emojiToIndex[r.emoji.name] && emojiToIndex[r.emoji.name] <= pool.length,
    { time: PICK_TIMEOUT_MS }
  )

  const chosen = new Set()
  await new Promise((resolve) => {
    secondCollector.on('collect', (r) => {
      const idx1b = emojiToIndex[r.emoji.name]
      if (!idx1b || idx1b > pool.length) return
      chosen.add(idx1b - 1)
      if (chosen.size >= 2) {
        secondCollector.stop('picked-two')
        resolve()
      }
    })
    secondCollector.on('end', (_, reason) => {
      if (reason !== 'picked-two') resolve()
    })
  })

  if (chosen.size < 2) {
    queue.draft.currentPicker = null
    queue.status = 'expired'
    queue.expiresAt = new Date().toISOString()
    await channel.send({
      embed: {
        color: 15158332,
        title: `Lobby ${queue?.lobby?.name || 'Lobby'} — Queue expired`,
        description: `No picks received within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes. The queue has been **disbanded**.`
      }
    })
    const { deletePlayerQueue } = require('../utils/managePlayerQueues')
    deletePlayerQueue(queue.lobby.id)
    return
  }

  const indices = [...chosen].sort((a, b) => b - a)
  const secondPicks = indices.map(i => pool.splice(i, 1)[0])
  queue.teams[second].players.push(...secondPicks)
  queue.draft.unpicked = pool.map(p => p.id)

  // last goes to first team
  if (pool.length === 1) {
    queue.teams[first].players.push(pool.pop())
    queue.draft.unpicked = []
  }

  queue.draft.currentPicker = null

  // Publish teams
  await channel.send({
    embed: {
      color: 3066993,
      title: 'Teams are ready!',
      fields: [
        { name: 'Blue',   value: queue.teams.blue.players.map(p => `<@${p.id}>`).join(', ') },
        { name: 'Orange', value: queue.teams.orange.players.map(p => `<@${p.id}>`).join(', ') },
      ]
    }
  })

  // Create voice channels
  try {
    await createVoiceChannels(eventObj, queue)
  } catch (e) {
    console.error('createVoiceChannels failed after draft', e?.message || e)
    await channel.send('Voice channel creation failed. An admin may need to check bot permissions.')
  }
}
