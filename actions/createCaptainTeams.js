// actions/createCaptainTeams.js
// Enhancements:
// - Reaction-based captain picking in **DMs** (first captain picks 1, second captain picks 2, last auto).
// - Sends each captain a scouting card: per-player MMR, lifetime W/L, monthly ΔMMR.
// - Publishes “currently picking” state in queue.draft so !status can show it.
// - Creates team voice channels after teams are finalized.

const { getStats, upsertPlayer } = require('../db')
const createVoiceChannels = require('./createVoiceChannels')

// 7 minutes per pick step (matches your vote timeout vibe)
const PICK_TIMEOUT_MS = 7 * 60 * 1000

const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'] // up to 4 remaining candidates

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
    const mem = guild?.members?.cache?.get?.(p.id)
    const uname = mem?.user?.username || p.username || String(p.id)
    try { await upsertPlayer({ guildId, userId: p.id, username: uname }) } catch {}
    const s = await statsLine(guildId, p.id, uname)
    lines.push(`**${i + 1}.** <@${p.id}> — MMR **${s.mmr}** — W/L **${s.w}/${s.l}** — ΔMMR (mo) **${fmtDelta(s.month)}**`)
  }
  return lines
}

async function sendPickDM({ captainMember, header, candidates }) {
  const lines = await buildScoutingCard(captainMember.guild, candidates)
  const dm = await captainMember.createDM()
  const body =
    `${header}\n\n` +
    `**Draft-Eligible Players**\n` +
    lines.join('\n') + '\n\n' +
    (candidates.length >= 2
      ? `React with the appropriate numbers within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes.`
      : `React with the number within ${Math.floor(PICK_TIMEOUT_MS/60000)} minutes.`)

  const msg = await dm.send(body)

  // react with the available indices
  for (let i = 0; i < Math.min(candidates.length, NUM_EMOJI.length); i++) {
    // eslint-disable-next-line no-await-in-loop
    await msg.react(NUM_EMOJI[i])
  }

  return msg
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

  // randomize who picks first
  const first = Math.random() < 0.5 ? 'blue' : 'orange'
  const second = first === 'blue' ? 'orange' : 'blue'
  queue.draft.currentPicker = first

  const blueMem   = guild.members.cache.get(blueCap.id)   || await guild.members.fetch(blueCap.id).catch(()=>null)
  const orangeMem = guild.members.cache.get(orangeCap.id) || await guild.members.fetch(orangeCap.id).catch(()=>null)

  if (!blueMem || !orangeMem) {
    await channel.send('Could not DM captains (missing guild members). Draft canceled.')
    queue.draft.currentPicker = null
    return
  }

  const emojiToIndex = Object.fromEntries(NUM_EMOJI.map((e, i) => [e, i + 1]))

  // ---------- FIRST PICK (1) via DM ----------
  const firstMem = first === 'blue' ? blueMem : orangeMem
  const firstHeader = `You have **first pick** for lobby **${queue?.lobby?.name || 'Lobby'}**.`
  const firstMsg = await sendPickDM({ captainMember: firstMem, header: firstHeader, candidates: pool })

  const firstCollector = firstMsg.createReactionCollector(
    (r, u) => u.id === firstMem.id && emojiToIndex[r.emoji.name] && emojiToIndex[r.emoji.name] <= pool.length,
    { time: PICK_TIMEOUT_MS }
  )

  const firstResult = await new Promise((resolve) => {
    firstCollector.on('collect', (r) => {
      firstCollector.stop('picked')
      resolve(emojiToIndex[r.emoji.name] - 1) // 0-based
    })
    firstCollector.on('end', (_, reason) => { if (reason !== 'picked') resolve(null) })
  })

  if (firstResult == null) {
    queue.draft.currentPicker = null
    await channel.send('Draft timed out (first pick). Lobby disbanded.')
    const { deletePlayerQueue } = require('../utils/managePlayerQueues')
    deletePlayerQueue(queue.lobby.id)
    return
  }

  const firstPickPlayer = pool.splice(firstResult, 1)[0]
  queue.teams[first].players.push(firstPickPlayer)
  queue.draft.unpicked = pool.map(p => p.id)

  // ---------- SECOND PICK (2) via DM ----------
  queue.draft.currentPicker = second
  const secondMem = second === 'blue' ? blueMem : orangeMem
  const secondHeader = `You have **two picks** for lobby **${queue?.lobby?.name || 'Lobby'}**.`
  const secondMsg = await sendPickDM({ captainMember: secondMem, header: secondHeader, candidates: pool })

  const secondCollector = secondMsg.createReactionCollector(
    (r, u) => u.id === secondMem.id && emojiToIndex[r.emoji.name] && emojiToIndex[r.emoji.name] <= pool.length,
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
    secondCollector.on('end', (_, reason) => { if (reason !== 'picked-two') resolve() })
  })

  if (chosen.size < 2) {
    queue.draft.currentPicker = null
    await channel.send('Draft timed out (second pick). Lobby disbanded.')
    const { deletePlayerQueue } = require('../utils/managePlayerQueues')
    deletePlayerQueue(queue.lobby.id)
    return
  }

  const indices = [...chosen].sort((a, b) => b - a)
  const secondPicks = indices.map(i => pool.splice(i, 1)[0])
  queue.teams[second].players.push(...secondPicks)
  queue.draft.unpicked = pool.map(p => p.id)

  // last player goes to first team
  if (pool.length === 1) {
    queue.teams[first].players.push(pool.pop())
    queue.draft.unpicked = []
  }

  queue.draft.currentPicker = null

  // Announce completed teams
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
