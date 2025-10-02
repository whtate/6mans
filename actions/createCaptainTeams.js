// actions/createCaptainTeams.js
// v11-compatible captain draft:
// - Announces captains in the queue channel
// - DMs captains a scouting card (MMR, lifetime W/L, month ΔMMR)
// - Captains pick by reacting in DM (1️⃣..4️⃣)
// - 7-minute timeout per pick; expired queue is announced + deleted
// - Creates voice channels after teams finalize

const { getStats, upsertPlayer } = require('../db')
const createVoiceChannels = require('./createVoiceChannels')

const PICK_TIMEOUT_MS =
  Number.isFinite(parseInt(process.env.PICK_TIMEOUT_MS, 10))
    ? parseInt(process.env.PICK_TIMEOUT_MS, 10)
    : 7 * 60 * 1000

const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣']

function randInt(n) { return Math.floor(Math.random() * n) }
function fmtDelta(n) { const v = Number(n) || 0; return `${v >= 0 ? '+' : ''}${v}` }

function clearDraftTimeout(queue) {
  if (queue && queue._draftTimeout) {
    clearTimeout(queue._draftTimeout)
    queue._draftTimeout = null
  }
}

function expireQueue(queue, channel, msg) {
  try {
    if (queue?.draft) queue.draft.currentPicker = null
    queue.status = 'expired'
    queue.expiresAt = new Date().toISOString()
  } catch (_) {}
  clearDraftTimeout(queue)
  channel.send({
    embed: {
      color: 15158332,
      title: `Lobby ${queue?.lobby?.name || 'Lobby'} — Queue expired`,
      description: msg || 'No picks received in time. The queue has been **disbanded**.'
    }
  })
  const { deletePlayerQueue } = require('../utils/managePlayerQueues')
  deletePlayerQueue(queue.lobby.id)
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
    // Resolve username via v11 members cache/fetchMember
    let mem = guild.members.get(p.id)
    if (!mem && guild.fetchMember) {
      try { mem = await guild.fetchMember(p.id) } catch (_) {}
    }
    const uname = mem?.user?.username || p.username || String(p.id)
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
  for (let i = 0; i < Math.min(candidates.length, NUM_EMOJI.length); i++) {
    // v11: Message.react returns a promise
    // eslint-disable-next-line no-await-in-loop
    await msg.react(NUM_EMOJI[i])
  }
  return msg
}

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel
  const guild   = eventObj.guild

  // normalize queue shape
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

  // Announce captains in the queue channel
  await channel.send({
    embed: {
      color: 2201331,
      title: 'Captain structure',
      description: 'The vote resulted in captains. The following are your captains:',
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
    return expireQueue(queue, channel, 'Captains could not be contacted via DM.')
  }

  // choose pick order
  const first = Math.random() < 0.5 ? 'blue' : 'orange'
  const second = first === 'blue' ? 'orange' : 'blue'
  queue.draft.currentPicker = first

  const emojiToIndex = Object.fromEntries(NUM_EMOJI.map((e, i) => [e, i + 1]))

  // helper: set a single queue._draftTimeout for the current step
  const armTimeout = (reason) => {
    clearDraftTimeout(queue)
    queue._draftTimeout = setTimeout(() => {
      // If queue was reset/remade, draft.currentPicker may be null; prevent stale timeout from firing.
      if (!queue || queue.draft?.currentPicker == null) return
      expireQueue(queue, channel, `${reason} within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes.`)
    }, PICK_TIMEOUT_MS)
  }

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
    return expireQueue(queue, channel, 'First pick could not be completed.')
  }

  armTimeout('No pick received')
  const firstCollector = firstMsg.createReactionCollector(
    (r, u) => u.id === (first === 'blue' ? blueMem.id : orangeMem.id) &&
              emojiToIndex[r.emoji.name] &&
              emojiToIndex[r.emoji.name] <= pool.length,
    { time: PICK_TIMEOUT_MS }
  )

  const firstResult = await new Promise((resolve) => {
    firstCollector.on('collect', (r) => {
      clearDraftTimeout(queue)
      firstCollector.stop('picked')
      resolve(emojiToIndex[r.emoji.name] - 1)
    })
    firstCollector.on('end', (_, reason) => {
      if (reason !== 'picked') resolve(null)
    })
  })

  if (firstResult == null) {
    return expireQueue(queue, channel, `No pick received within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes.`)
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
    return expireQueue(queue, channel, 'Second pick could not be completed.')
  }

  armTimeout('No picks received')
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
        clearDraftTimeout(queue)
        secondCollector.stop('picked-two')
        resolve()
      }
    })
    secondCollector.on('end', (_, reason) => {
      if (reason !== 'picked-two') resolve()
    })
  })

  if (chosen.size < 2) {
    return expireQueue(queue, channel, `No picks received within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes.`)
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
  clearDraftTimeout(queue)

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
