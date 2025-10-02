// actions/createCaptainTeams.js
// Captains draft (reaction-in-DMs picking), then DM lobby info to all 6 players and
// announce a host in the queue channel. Works on discord.js v11 APIs.

const { getStats, upsertPlayer } = require('../db')
const createVoiceChannels = require('./createVoiceChannels')
const { registerActiveMatch } = require('../utils/managePlayerQueues')
const createLobbyInfo = require('./createLobbyInfo') // <-- DMs lobby name/password & announces host

function rand(n) {
  return Math.floor(Math.random() * n)
}

function fmtDelta(n) {
  const v = Number(n) || 0
  return `${v >= 0 ? '+' : ''}${v}`
}

async function getStatsLine(guildId, id, fallbackUsername) {
  try {
    await upsertPlayer({ guildId, userId: id, username: fallbackUsername || String(id) })
    const s = await getStats({ guildId, userId: id })
    const life = s?.life || {}
    const month = s?.month || {}
    const name = life.username || fallbackUsername || String(id)
    return {
      text: `• <@${id}> — **MMR ${life.mmr ?? 1000}** — **W/L ${life.wins ?? 0}/${life.losses ?? 0}** — **ΔMMR (mo) ${fmtDelta(month.mmr_delta || 0)}**`,
      username: name
    }
  } catch {
    return { text: `• <@${id}> — **MMR 1000** — **W/L 0/0** — **ΔMMR (mo) +0**`, username: fallbackUsername || String(id) }
  }
}

async function sendCaptainPromptDM(client, captainId, candidateIds, guildId) {
  const user = client.users.get(captainId) // v11
  if (!user) throw new Error('Captain user not found')

  const lines = []
  for (const id of candidateIds) {
    const line = await getStatsLine(guildId, id, null)
    lines.push(line.text)
  }

  const dm = await user.createDM()
  const msg = await dm.send(
    `You are a **captain**. React with the number for the player you pick.\n\n` +
    lines.map((t, i) => `${i + 1}. ${t}`).join('\n')
  )

  // add number reactions 1..candidateIds.length (limited to 4 for 6mans)
  const numerals = ['1️⃣','2️⃣','3️⃣','4️⃣']
  for (let i = 0; i < candidateIds.length && i < numerals.length; i++) {
    await msg.react(numerals[i])
  }

  return { dm, msg }
}

function emojiToIndex(name) {
  return ({ '1️⃣':0, '2️⃣':1, '3️⃣':2, '4️⃣':3 })[name]
}

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel
  const guildId = eventObj.guild?.id
  const client = require('../index') // v11 client

  // normalize
  queue.players = (queue.players || []).filter(Boolean)
  queue.teams = queue.teams || { blue: { players: [] }, orange: { players: [] } }
  const players = [...queue.players] // copy we’ll mutate locally

  // pick captains
  const blueCaptain = players.splice(rand(players.length), 1)[0]
  const orangeCaptain = players.splice(rand(players.length), 1)[0]
  queue.teams.blue.captain = blueCaptain
  queue.teams.orange.captain = orangeCaptain
  queue.teams.blue.players.push(blueCaptain)
  queue.teams.orange.players.push(orangeCaptain)

  // announce captains in channel
  await channel.send({
    embed: {
      color: 2201331,
      title: `Captain structure`,
      description: 'Captains have been selected. They will pick via DM.',
      fields: [
        { name: 'Captain Blue', value: `<@${blueCaptain.id}>`, inline: true },
        { name: 'Captain Orange', value: `<@${orangeCaptain.id}>`, inline: true },
      ],
    },
  })

  // DM prompts (Blue picks 1, then Orange picks 2; last goes to Blue)
  const candidates1 = players.map(p => p.id) // 4 candidates
  const { msg: blueMsg } = await sendCaptainPromptDM(client, blueCaptain.id, candidates1, guildId)

  // collector for blue's first pick
  const blueCollector = blueMsg.createReactionCollector(
    (r, u) => u.id === blueCaptain.id && ['1️⃣','2️⃣','3️⃣','4️⃣'].includes(r.emoji.name),
    { time: (Number(process.env.DRAFT_PICK_TIMEOUT_MS) || 7*60*1000) }
  )

  let firstPickIndex = null

  blueCollector.on('collect', (r) => {
    const idx = emojiToIndex(r.emoji.name)
    if (idx != null && candidates1[idx]) {
      firstPickIndex = idx
      blueCollector.stop('picked')
    }
  })

  blueCollector.on('end', async (_, reason) => {
    if (reason !== 'picked') {
      // expire draft cleanly
      queue.status = 'expired'
      queue.expiresAt = new Date().toISOString()
      if (queue._draftTimeout) { clearTimeout(queue._draftTimeout); queue._draftTimeout = null }
      return channel.send({
        embed: {
          color: 15158332,
          title: `Lobby ${queue?.lobby?.name || 'Lobby'} — Draft expired`,
          description: `No pick received in time. The queue has been **disbanded**.`
        }
      })
    }

    // apply blue first pick
    const picked1Id = candidates1[firstPickIndex]
    const picked1 = players.splice(firstPickIndex, 1)[0]
    queue.teams.blue.players.push(picked1)

    // now orange picks two
    const candidates2 = players.map(p => p.id) // 3 players left
    const { msg: orangeMsg } = await sendCaptainPromptDM(client, orangeCaptain.id, candidates2, guildId)
    const needed = 2
    const chosen = new Set()

    const orangeCollector = orangeMsg.createReactionCollector(
      (r, u) => u.id === orangeCaptain.id && ['1️⃣','2️⃣','3️⃣','4️⃣'].includes(r.emoji.name),
      { time: (Number(process.env.DRAFT_PICK_TIMEOUT_MS) || 7*60*1000) }
    )

    orangeCollector.on('collect', (r) => {
      const idx = emojiToIndex(r.emoji.name)
      if (idx != null && candidates2[idx] && !chosen.has(idx)) {
        chosen.add(idx)
        if (chosen.size >= needed) orangeCollector.stop('picked')
      }
    })

    orangeCollector.on('end', async (_, reason2) => {
      if (reason2 !== 'picked') {
        queue.status = 'expired'
        queue.expiresAt = new Date().toISOString()
        if (queue._draftTimeout) { clearTimeout(queue._draftTimeout); queue._draftTimeout = null }
        return channel.send({
          embed: {
            color: 15158332,
            title: `Lobby ${queue?.lobby?.name || 'Lobby'} — Draft expired`,
            description: `No pick received in time. The queue has been **disbanded**.`
          }
        })
      }

      // apply orange two picks (sort desc to splice correctly)
      const idxs = Array.from(chosen).sort((a,b)=>b-a)
      for (const idx of idxs) {
        const pickId = candidates2[idx]
        const pIndex = players.findIndex(p => p.id === pickId)
        if (pIndex >= 0) {
          queue.teams.orange.players.push(players.splice(pIndex, 1)[0])
        }
      }

      // last player goes to blue
      if (players.length === 1) {
        queue.teams.blue.players.push(players.pop())
      }

      // publish teams
      await channel.send({
        embed: {
          color: 3066993,
          title: 'Teams are ready!',
          fields: [
            {
              name: 'Blue',
              value: queue.teams.blue.players.map(p => `<@${p.id}>`).join(', ')
            },
            {
              name: 'Orange',
              value: queue.teams.orange.players.map(p => `<@${p.id}>`).join(', ')
            }
          ]
        }
      })

      // register active match so players can't re-queue before reporting
      const teamAIds = queue.teams.blue.players.map(p => p.id)
      const teamBIds = queue.teams.orange.players.map(p => p.id)
      registerActiveMatch(queue, teamAIds, teamBIds)

      // create VCs and DM all 6 players lobby info (name/password) privately.
      try {
        await createVoiceChannels(eventObj, queue)
      } catch (e) {
        console.error('VC creation failed (captains path):', e?.message || e)
      }

      try {
        // This DMs host + all players; channel announcement only says who should host.
        await createLobbyInfo(eventObj, queue)
      } catch (e) {
        console.error('createLobbyInfo failed (captains path):', e?.message || e)
      }
    })
  })
}
