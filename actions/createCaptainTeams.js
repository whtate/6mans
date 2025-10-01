// actions/createCaptainTeams.js
// Captain draft via DM + reactions (1–4). Works in v11–v14.
// After teams are finalized, we now create voice channels and then DM lobby details
// (no public leak of lobby name/password).

const { randomInt } = require('crypto')
const createVoiceChannels = require('./createVoiceChannels')
const createLobbyInfo = require('./createLobbyInfo')

function rand(n) {
  return typeof randomInt === 'function' ? randomInt(n) : Math.floor(Math.random() * n)
}

const DIGITS = ['1️⃣','2️⃣','3️⃣','4️⃣'] // up to 4 remaining players in 6-mans
const PICK_TIMEOUT_MS =
  Number.isFinite(parseInt(process.env.PICK_TIMEOUT_MS, 10))
    ? parseInt(process.env.PICK_TIMEOUT_MS, 10)
    : 60_000 // 60s per pick

function getGuildClient() {
  try { return require('../index') } catch { return null }
}

function getUser(client, id) {
  if (!client) return null
  // v12+
  if (client.users?.cache?.get) return client.users.cache.get(id) || null
  // v11
  if (client.users?.get) return client.users.get(id) || null
  return null
}

function mention(id) {
  return /^\d+$/.test(id) ? `<@${id}>` : String(id)
}

function listWithNumbers(players) {
  return players.map((p, i) => `${i + 1}. ${mention(p.id)}`).join('\n')
}

async function addDigitReactions(msg, n) {
  for (let i = 0; i < n && i < DIGITS.length; i++) {
    try { /* eslint-disable no-await-in-loop */ await msg.react(DIGITS[i]) } catch {}
  }
}

function awaitOneReaction(msg, userId, allowed, time = PICK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const filter = (reaction, user) =>
      allowed.includes(reaction.emoji.name) && user.id === userId
    const collector = msg.createReactionCollector(filter, { max: 1, time })
    let picked = null
    collector.on('collect', (reaction) => { picked = reaction.emoji.name })
    collector.on('end', () => resolve(picked))
  })
}

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel
  const client = getGuildClient()

  // Normalize structure
  queue.players = (queue.players || []).filter(Boolean)
  queue.teams = queue.teams || { blue: { players: [] }, orange: { players: [] } }
  const { players, teams } = queue

  // Safety: exactly 6 players needed for this flow
  if (players.length !== 6) {
    await channel.send('Captain draft requires exactly 6 players.')
    return
  }

  // Initialize public draft state for !status
  queue.draft = {
    mode: 'captains',
    currentPicker: null,        // 'blue'|'orange'
    currentCaptainId: null,     // single id for status
    captains: { blue: null, orange: null },
    picks: [],
    unpicked: players.map(p => p.id),
  }
  queue.status = 'drafting'
  queue.votingInProgress = false
  queue.creatingTeamsInProgress = true

  // Random captains
  const order = [...players]
  const bIdx = rand(order.length)
  const blueCaptain = order.splice(bIdx, 1)[0]
  const oIdx = rand(order.length)
  const orangeCaptain = order.splice(oIdx, 1)[0]

  teams.blue.captain = blueCaptain
  teams.orange.captain = orangeCaptain
  teams.blue.players = [blueCaptain]
  teams.orange.players = [orangeCaptain]

  queue.draft.captains.blue = blueCaptain.id
  queue.draft.captains.orange = orangeCaptain.id

  await channel.send({
    embed: {
      color: 2201331,
      title: 'Captain structure',
      description: 'The vote resulted in captains. The following are your captains:',
      fields: [
        { name: 'Captain Blue', value: mention(blueCaptain.id) },
        { name: 'Captain Orange', value: mention(orangeCaptain.id) },
      ],
    },
  })

  // Helper to DM a captain and get one pick via reaction
  const dmPickOne = async (captain, poolPlayers, promptTitle) => {
    const user = getUser(client, captain.id)
    if (!user) throw new Error('Captain user not found to DM')

    const dm = await user.createDM()
    const dmMsg = await dm.send({
      embed: {
        color: 3447003,
        title: promptTitle,
        description:
          'React with the number for your pick. You have **60 seconds**.\n\n' +
          listWithNumbers(poolPlayers),
      },
    })

    await addDigitReactions(dmMsg, poolPlayers.length)
    const emoji = await awaitOneReaction(dmMsg, captain.id, DIGITS.slice(0, poolPlayers.length), PICK_TIMEOUT_MS)
    if (!emoji) return null // timeout

    const idx = DIGITS.indexOf(emoji) // 0-based index into poolPlayers
    if (idx < 0 || !poolPlayers[idx]) return null
    return poolPlayers[idx]
  }

  // Helper to DM a captain and get TWO picks via sequential reactions
  const dmPickTwoSequential = async (captain, poolPlayers) => {
    const picks = []
    const first = await dmPickOne(captain, poolPlayers, 'Second pick (1 of 2)')
    if (!first) return null
    picks.push(first)
    const remaining = poolPlayers.filter(p => p.id !== first.id)
    const second = await dmPickOne(captain, remaining, 'Second pick (2 of 2)')
    if (!second) return null
    picks.push(second)
    return picks
  }

  // FIRST PICK: randomly choose who picks first
  const firstSide = rand(2) === 0 ? 'blue' : 'orange'
  const secondSide = firstSide === 'blue' ? 'orange' : 'blue'

  // pool of non-captains (4 remaining)
  let pool = players.filter(p => p.id !== blueCaptain.id && p.id !== orangeCaptain.id)

  // --- First pick (1) ---
  queue.draft.currentPicker = firstSide
  queue.draft.currentCaptainId = teams[firstSide].captain.id
  await channel.send(`First pick: ${mention(teams[firstSide].captain.id)} — check your **DMs** to select **one** player.`)

  const firstPick = await dmPickOne(teams[firstSide].captain, pool, 'First pick (pick 1)')
  if (!firstPick) {
    queue.draft.currentPicker = null
    queue.draft.currentCaptainId = null
    queue.creatingTeamsInProgress = false
    await channel.send('Draft timed out (first pick).')
    return
  }
  teams[firstSide].players.push(firstPick)
  queue.draft.picks.push({ by: teams[firstSide].captain.id, picked: firstPick.id })
  pool = pool.filter(p => p.id !== firstPick.id)
  queue.draft.unpicked = pool.map(p => p.id)

  // --- Second pick (2) ---
  queue.draft.currentPicker = secondSide
  queue.draft.currentCaptainId = teams[secondSide].captain.id
  await channel.send(`Second pick: ${mention(teams[secondSide].captain.id)} — check your **DMs** to select **two** players (one at a time).`)

  const secondPicks = await dmPickTwoSequential(teams[secondSide].captain, pool)
  if (!secondPicks || secondPicks.length < 2) {
    queue.draft.currentPicker = null
    queue.draft.currentCaptainId = null
    queue.creatingTeamsInProgress = false
    await channel.send('Draft timed out (second pick).')
    return
  }
  teams[secondSide].players.push(secondPicks[0], secondPicks[1])
  queue.draft.picks.push(
    { by: teams[secondSide].captain.id, picked: secondPicks[0].id },
    { by: teams[secondSide].captain.id, picked: secondPicks[1].id },
  )
  pool = pool.filter(p => !secondPicks.find(sp => sp.id === p.id))
  queue.draft.unpicked = pool.map(p => p.id)

  // --- Last auto to the first side ---
  if (pool.length === 1) {
    const last = pool[0]
    teams[firstSide].players.push(last)
    queue.draft.picks.push({ by: teams[firstSide].captain.id, picked: last.id, auto: true })
    pool = []
  }
  queue.draft.unpicked = pool.map(p => p.id)
  queue.draft.currentPicker = null
  queue.draft.currentCaptainId = null

  // Announce teams
  await channel.send({
    embed: {
      color: 3066993,
      title: 'Teams are ready!',
      fields: [
        { name: 'Blue',   value: teams.blue.players.map(p => mention(p.id)).join(', ') },
        { name: 'Orange', value: teams.orange.players.map(p => mention(p.id)).join(', ') },
      ],
    },
  })

  // NEW: create voice channels first, then DM lobby info to players
  try {
    await createVoiceChannels(eventObj, queue)
  } catch (e) {
    console.error('createVoiceChannels failed (captains):', e)
    // continue to DM lobby info even if VC creation fails
  }

  try {
    await createLobbyInfo(eventObj, queue)
  } catch (e) {
    console.error('createLobbyInfo failed after captain draft:', e)
  } finally {
    queue.creatingTeamsInProgress = false
  }
}
