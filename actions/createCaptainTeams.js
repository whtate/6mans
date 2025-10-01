// actions/createCaptainTeams.js
// v11-friendly DM draft:
// - Resolve captains via guild.members.get/fetchMember → member.user.createDM()
// - Reaction-based selection in DMs using 1️⃣ 2️⃣ 3️⃣ 4️⃣
// - Loud 7-min timeout that expires the queue and deletes it
// - Creates voice channels after teams are ready

const { getStats, upsertPlayer } = require('../db')
const createVoiceChannels = require('./createVoiceChannels')

const PICK_TIMEOUT_MS = 7 * 60 * 1000
const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣']

function randInt(n) { return Math.floor(Math.random() * n) }
function fmtDelta(n) { const v = Number(n) || 0; return `${v >= 0 ? '+' : ''}${v}` }

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
    // Resolve username via guild members (v11)
    let uname = p.username || null
    let mem = guild.members.get(p.id)
    if (!mem && guild.fetchMember) {
      try { mem = await guild.fetchMember(p.id) } catch (_) {}
    }
    if (mem && mem.user) {
      uname = mem.user.username || uname || String(p.id)
    } else {
      uname = uname || String(p.id)
    }
    try { await upsertPlayer({ guildId, userId: p.id, username: uname }) } catch {}
    const s = await statsLine(guildId, p.id, uname)
    lines.push(`**${i + 1}.** <@${p.id}> — MMR **${s.mmr}** — W/L **${s.w}/${s.l}** — ΔMMR (mo) **${fmtDelta(s.month)}**`)
  }
  return lines
}

async function sendPickDM({ member, header, guild, candidates }) {
  const lines = await buildScoutingCard(guild, candidates)
  const dm = await member.user.createDM()
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

function expireQueue(queue, channel, reasonText) {
  try {
    queue.draft && (queue.draft.currentPicker = null)
    queue.status = 'expired'
    queue.expiresAt = new Date().toISOString()
  } catch (_) {}
  channel.send({
    embed: {
      color: 15158332,
      title: `Lobby ${queue?.lobby?.name || 'Lobby'} — Queue expired`,
      description: reasonText || 'No picks received in time. The queue has been **disbanded**.'
    }
  })
  const { deletePlayerQueue } = require('../utils/managePlayerQueues')
  deletePlayerQueue(queue.lobby.id)
}

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel
  const guild   = eventObj.guild

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

  // Resolve GuildMembers (v11) to DM captains
  let blueMem = guild.members.get(blueCap.id)
  if (!blueMem && guild.fetchMember) {
    try { blueMem = await guild.fetchMember(blueCap.id) } catch (_) {}
  }
  let orangeMem = guild.members.get(orangeCap.id)
  if (!orangeMem && guild.fetchMember) {
    try { orangeMem = await guild.fetchMember(orangeCap.id) } catch (_) {}
  }

  if (!blueMem || !orangeMem) {
    await channel.send('Could not DM captains (couldn’t resolve guild members). Ask them to enable DMs / check bot permissions.')
    expireQueue(queue, channel, 'Captains could not be contacted via DM.')
    return
  }

  // randomize who picks first
  const first = Math.random() < 0.5 ? 'blue' : 'orange'
  const second = first === 'blue' ? 'orange' : 'blue'
  queue.draft.currentPicker = first

  const emojiToIndex = Object.fromEntries(NUM_EMOJI.map((e, i) => [e, i + 1]))

  // ---------- FIRST PICK (1) via DM ----------
  let firstMsg
  try {
    firstMsg = await sendPickDM({
      member: first === 'blue' ? blueMem : orangeMem,
      header: `You have **first pick** for **${queue?.lobby?.name || 'Lobby'}**.`,
      guild,
      candidates: pool
    })
  } catch (e) {
    await channel.send(`I couldn’t DM the captain for the first pick. Make sure DMs are enabled.`)
    expireQueue(queue, channel, 'First pick could not be completed.')
    return
  }

  const firstCollector = firstMsg.createReactionCollector(
    (r, u) => u.id === (first === 'blue' ? blueMem.id : orangeMem.id) &&
              emojiToIndex[r.emoji.name] &&
              emojiToIndex[r.emoji.name] <= pool.length,
    { time: PICK_TIMEOUT_MS }
  )

  const firstResult = await new Promise((resolve) => {
    firstCollector.on('collect', (r) => {
      firstCollector.stop('picked')
      resolve(emojiToIndex[r.emoji.name] - 1) // 0-based index
    })
    firstCollector.on('end', (_, reason) => {
      if (reason !== 'picked') resolve(null)
    })
  })

  if (firstResult == null) {
    expireQueue(queue, channel, `No pick received within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes.`)
    return
  }

  const firstPickPlayer = pool.splice(firstResult, 1)[0]
  queue.teams[first].players.push(firstPickPlayer)
  queue.draft.unpicked = pool.map(p => p.id)

  // ---------- SECOND PICK (2) via DM ----------
  queue.draft.currentPicker = second
  let secondMsg
  try {
    secondMsg = await sendPickDM({
      member: second === 'blue' ? blueMem : orangeMem,
      header: `You have **two picks** for **${queue?.lobby?.name || 'Lobby'}**.`,
      guild,
      candidates: pool
    })
  } catch (e) {
    await channel.send(`I couldn’t DM the captain for the second pick. Make sure DMs are enabled.`)
    expireQueue(queue, channel, 'Second pick could not be completed.')
    return
  }

  const chosen = new Set()
  const secondCollector = secondMsg.createReactionCollector(
    (r, u) => u.id === (second === 'blue' ? blueMem.id : orangeMem.id) &&
              emojiToIndex[r.emoji.name] &&
              emojiToIndex[r.emoji.name] <= pool.length,
    { time: PICK_TIMEOUT_MS }
  )

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
    expireQueue(queue, channel, `No picks received within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes.`)
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
    console.error('createVoiceChannels failed after draft', e && e.message)
    await channel.send('Voice channel creation failed. An admin may need to check bot permissions.')
  }
}
