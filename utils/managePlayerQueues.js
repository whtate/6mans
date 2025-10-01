// utils/managePlayerQueues.js
const randomstring = require('randomstring')
const playerIdsIndexedToMentions = require('../utils/playerIdsIndexedToMentions')
const { commandToString } = require('./commands')
const cloneDeep = require('lodash.clonedeep')

const BRAND  = process.env.lobbyName || 'in-house 6mans'
const REGION = process.env.lobbyRegion || null
const SERIES = Number.isFinite(parseInt(process.env.lobbySeries, 10))
  ? parseInt(process.env.lobbySeries, 10)
  : null

const REQUIRED_PLAYERS =
  Number.isFinite(parseInt(process.env.REQUIRED_PLAYERS, 10))
    ? parseInt(process.env.REQUIRED_PLAYERS, 10)
    : 6

const AUTODISBAND_MS = Number.isFinite(parseInt(process.env.AUTODISBAND_MS, 10))
  ? parseInt(process.env.AUTODISBAND_MS, 10)
  : (0) // disable old pre-fill disband by default when per-player keepalive is used

const KEEPALIVE_MS =
  Number.isFinite(parseInt(process.env.KEEPALIVE_MS, 10))
    ? parseInt(process.env.KEEPALIVE_MS, 10)
    : 60 * 60 * 1000 // 1 hour

const KEEPALIVE_WARN_MS =
  Number.isFinite(parseInt(process.env.KEEPALIVE_WARN_MS, 10))
    ? parseInt(process.env.KEEPALIVE_WARN_MS, 10)
    : 5 * 60 * 1000 // 5 minutes

// ---- per-guild state ----
const guildStates = new Map()  // key: guildId or '_default'
let globalLobbyId = 0

function getGuildKey(guildId) { return guildId || '_default' }

function getGuildState(guildId) {
  const key = getGuildKey(guildId)
  if (!guildStates.has(key)) {
    guildStates.set(key, {
      nextLobbyNumber: 1,
      queues: [],
      activeByPlayer: new Map(), // userId -> queue (with activeMatch)
    })
  }
  return guildStates.get(key)
}

// ---- queue template ----
const queueResetValues = {
  votingInProgress: false,
  votes: { r: 0, c: 0, playersWhoVoted: {} },
  creatingTeamsInProgress: false,
  teams: {
    blue:   { players: [], captain: undefined, voiceChannelID: undefined, voiceChannelHistory: {} },
    orange: { players: [], captain: undefined, voiceChannelID: undefined, voiceChannelHistory: {} },
  },
  readyToJoin: false,

  // Remake voting
  remakeVotes: 0,
  playersWhoRemakeVoted: {},

  // runtime-only handles
  _voteTimeout: null,
}

function createQueue(guildId) {
  const state = getGuildState(guildId)
  const number = state.nextLobbyNumber++
  const lobbyId = ++globalLobbyId

  const queue = {
    guildId: guildId || null,
    lobby: {
      id: lobbyId,
      number,
      label: `Lobby #${number}`,
      name: `${BRAND} — Lobby #${number}`,
      brand: BRAND,
      region: REGION,
      series: SERIES,
      // digits-only code avoids accidental words
      password: randomstring.generate({ length: 4, charset: '23456789' }),
    },

    players: [],
    playerIdsIndexed: {},
    ...cloneDeep(queueResetValues),

    activeMatch: null,    // { teamAIds, teamBIds } once teams are formed
    createdAt: Date.now(),

    // old queue-level timers (kept for compatibility)
    autoDisbandTimer: null,

    // NEW: per-player keepalive structure
    keepAlive: {
      // [userId]: { warnTO, kickTO, untilTs }
    },
  }

  // (Optional) legacy pre-fill disband (disabled by default)
  if (AUTODISBAND_MS > 0) {
    queue.autoDisbandTimer = setTimeout(() => {
      const count = Object.keys(queue.playerIdsIndexed).length
      if (count < REQUIRED_PLAYERS && !queue.votingInProgress && !queue.activeMatch) {
        deletePlayerQueue(queue.lobby.id)
      }
    }, AUTODISBAND_MS)
  }

  state.queues.push(queue)
  return queue
}

function listQueues(guildId) { return getGuildState(guildId).queues }

function findPlayersQueue(guildId, userId) {
  return listQueues(guildId).find(q => q.playerIdsIndexed[userId]) || null
}

function findJoinableQueue(guildId) {
  const open = listQueues(guildId)
    .filter(q => !q.votingInProgress && !q.activeMatch && Object.keys(q.playerIdsIndexed).length < REQUIRED_PLAYERS)
    .sort((a,b) => {
      const ca = Object.keys(a.playerIdsIndexed).length
      const cb = Object.keys(b.playerIdsIndexed).length
      if (ca !== cb) return ca - cb
      return a.lobby.number - b.lobby.number
    })
  return open[0] || null
}

function determinePlayerQueue(playerId, command, guildId) {
  const state = getGuildState(guildId)

  // If already in a queue, use it
  const playersQueue = findPlayersQueue(guildId, playerId)
  if (playersQueue) return playersQueue

  // Only create/assign on join
  if (command !== commandToString.queue) {
    if (state.queues.length === 0) return undefined
    return null
  }

  const notFull = findJoinableQueue(guildId)
  if (notFull) return notFull
  return createQueue(guildId)
}

// Helper: announce in the queue text channel (best-effort)
function announceToQueueChannel(queue, text) {
  try {
    const client = require('../index')
    const guild  = client.guilds.get(queue.guildId)
    const chan   = guild && guild.channels.find(ch => ch.type === 'text' && ch.name === process.env.channelName)
    if (chan) chan.send(text)
  } catch (e) {
    console.error('announceToQueueChannel failed', e)
  }
}

// ---- NEW: per-player keepalive management ----
async function startKeepAlive(queue, userId) {
  try {
    if (!queue.keepAlive) queue.keepAlive = {}
    // clear any existing timers first
    cancelKeepAlive(queue, userId)

    const client = require('../index')
    const user = client.users.get(userId)
    if (!user) return

    const untilTs = Date.now() + KEEPALIVE_MS
    const warnDelay = Math.max(untilTs - Date.now() - KEEPALIVE_WARN_MS, 0)
    const kickDelay = Math.max(untilTs - Date.now(), 0)

    // Schedule warning DM
    const warnTO = setTimeout(async () => {
      try {
        const dm = await user.send(
          `⏳ You’ve been in **${queue.lobby.name}** for almost an hour.\n` +
          `React with ✅ in the next **${Math.round(KEEPALIVE_WARN_MS/60000)} minutes** to **stay in the queue for another hour**.\n\n` +
          `If you don’t react, you’ll be removed.`
        )
        await dm.react('✅')

        // v11 reaction collector
        const filter = (reaction, reactor) => reaction.emoji.name === '✅' && reactor.id === userId
        const collector = dm.createReactionCollector(filter, { time: KEEPALIVE_WARN_MS })

        let extended = false
        collector.on('collect', () => {
          extended = true
          collector.stop('extended')
        })

        collector.on('end', (collected, reason) => {
          if (reason === 'extended' && extended) {
            // player opted to stay: reset for another hour
            // only if they are STILL in this queue
            if (queue.playerIdsIndexed[userId]) {
              // reschedule fresh window
              cancelKeepAlive(queue, userId)
              startKeepAlive(queue, userId)
              user.send('✅ Got it — you’ll **stay in the queue for another hour**.')
            }
          }
        })
      } catch (e) {
        console.error('keepalive warn DM failed', e)
      }
    }, warnDelay)

    // Schedule kick removal
    const kickTO = setTimeout(() => {
      try {
        // If user is still in this queue AND didn’t extend, remove them
        if (queue.playerIdsIndexed[userId]) {
          // remove from queue
          delete queue.playerIdsIndexed[userId]
          if (Array.isArray(queue.players)) {
            queue.players = queue.players.filter(p => p.id !== userId)
          }
          announceToQueueChannel(queue, `⌛ <@${userId}> was **removed from the queue** (inactive).`)
          // DM them
          user.send(`You were removed from **${queue.lobby.name}** due to inactivity. You can **!q** again anytime.`)
        }
      } catch (e) {
        console.error('keepalive kick failed', e)
      } finally {
        cancelKeepAlive(queue, userId)
      }
    }, kickDelay)

    queue.keepAlive[userId] = { warnTO, kickTO, untilTs }
  } catch (e) {
    console.error('startKeepAlive failed', e)
  }
}

function cancelKeepAlive(queue, userId) {
  if (!queue || !queue.keepAlive || !queue.keepAlive[userId]) return
  const { warnTO, kickTO } = queue.keepAlive[userId]
  if (warnTO) clearTimeout(warnTO)
  if (kickTO) clearTimeout(kickTO)
  delete queue.keepAlive[userId]
}

function cancelAllKeepAlive(queue) {
  if (!queue || !queue.keepAlive) return
  for (const uid of Object.keys(queue.keepAlive)) {
    cancelKeepAlive(queue, uid)
  }
}

// When teams/VCs are created, call this so players are free to re-queue
function registerActiveMatch(queue, teamAIds, teamBIds) {
  queue.activeMatch = { teamAIds: [...teamAIds], teamBIds: [...teamBIds] }
  queue.votingInProgress = false
  queue.creatingTeamsInProgress = false

  // Cancel auto-disband + vote timers; match is in progress
  if (queue.autoDisbandTimer) { clearTimeout(queue.autoDisbandTimer); queue.autoDisbandTimer = null }
  if (queue._voteTimeout)     { clearTimeout(queue._voteTimeout);     queue._voteTimeout = null }

  // Cancel per-player keepalive while they play
  cancelAllKeepAlive(queue)

  // Free players from queue (so they can join another queue immediately if they want after)
  const state = getGuildState(queue.guildId)
  for (const id of [...teamAIds, ...teamBIds]) {
    delete queue.playerIdsIndexed[id]
    if (queue.players?.length) {
      queue.players = queue.players.filter(p => (p.id || p) !== id)
    }
    state.activeByPlayer.set(id, queue)
  }
}

// After match is reported or lobby is remade, clear the active mapping
function clearActiveMatch(queue) {
  const state = getGuildState(queue.guildId)
  if (queue.activeMatch) {
    for (const id of [...queue.activeMatch.teamAIds, ...queue.activeMatch.teamBIds]) {
      if (state.activeByPlayer.get(id) === queue) {
        state.activeByPlayer.delete(id)
      }
    }
  }
  queue.activeMatch = null
}

function findActiveMatchQueueByPlayer(guildId, userId) {
  const state = getGuildState(guildId)
  return state.activeByPlayer.get(userId) || null
}

function deletePlayerQueue(lobbyId) {
  for (const [, state] of guildStates) {
    const idx = state.queues.findIndex(q => q.lobby.id === lobbyId)
    if (idx >= 0) {
      const q = state.queues[idx]
      if (q.autoDisbandTimer) clearTimeout(q.autoDisbandTimer)
      if (q._voteTimeout)     clearTimeout(q._voteTimeout)
      cancelAllKeepAlive(q)
      // clear active index
      if (q.activeMatch) {
        for (const id of [...q.activeMatch.teamAIds, ...q.activeMatch.teamBIds]) {
          if (state.activeByPlayer.get(id) === q) state.activeByPlayer.delete(id)
        }
      }
      state.queues.splice(idx, 1)
      return
    }
  }
}

// Fully clear players & indices so users can requeue after remake
function resetPlayerQueue(lobbyId) {
  for (const [, state] of guildStates) {
    const idx = state.queues.findIndex(q => q.lobby.id === lobbyId)
    if (idx === -1) continue
    const q = state.queues[idx]

    if (q.autoDisbandTimer) { clearTimeout(q.autoDisbandTimer); q.autoDisbandTimer = null }
    if (q._voteTimeout)     { clearTimeout(q._voteTimeout);     q._voteTimeout = null }
    cancelAllKeepAlive(q)

    const preserved = {
      guildId: q.guildId,
      lobby: q.lobby,
      createdAt: Date.now(),
    }
    // wipe players & state entirely
    const fresh = Object.assign({}, preserved, cloneDeep(queueResetValues))
    fresh.players = []
    fresh.playerIdsIndexed = {}
    fresh.activeMatch = null
    fresh.keepAlive = {}

    // optional legacy pre-fill timer
    if (AUTODISBAND_MS > 0) {
      fresh.autoDisbandTimer = setTimeout(() => {
        const count = Object.keys(fresh.playerIdsIndexed).length
        if (count < REQUIRED_PLAYERS && !fresh.votingInProgress && !fresh.activeMatch) {
          deletePlayerQueue(fresh.lobby.id)
        }
      }, AUTODISBAND_MS)
    }

    state.queues[idx] = fresh
    return
  }
}

function kickPlayer(playerIndex, queue, messageChannel) {
  const playerObj = queue.players[playerIndex]
  if (!playerObj) return
  const playerId = playerObj.id
  delete queue.playerIdsIndexed[playerId]
  queue.players.splice(playerIndex, 1)
  cancelKeepAlive(queue, playerId)
  if (messageChannel) {
    messageChannel(`<@${playerId}> has been kicked. You can check the lobby status with ${commandToString.status}`)
  }
  // do not reset whole lobby; keep others
}

function removeOfflinePlayerFromQueue({ playerId, playerChannels, guildId }) {
  let playersQueue = findPlayersQueue(guildId, playerId)
  if (!playersQueue) {
    // If player is in an active match, ignore (they're not in queue)
    const state = getGuildState(guildId)
    if (state.activeByPlayer.get(playerId)) return
    return
  }

  playersQueue.players = playersQueue.players.filter(p => p.id !== playerId)
  delete playersQueue.playerIdsIndexed[playerId]
  cancelKeepAlive(playersQueue, playerId)

  const channel = playerChannels.find(ch => ch.name === process.env.channelName)

  if (Object.keys(playersQueue.playerIdsIndexed).length === 0) {
    deletePlayerQueue(playersQueue.lobby.id)
  } else if (channel) {
    channel.send({
      embed: {
        color: 2201331,
        title: `Lobby ${playersQueue.lobby.name} - Player removed`,
        description: `<@${playerId}> was removed from the queue because they went offline.`,
        fields: [
          { name: 'Players in the queue', value: playerIdsIndexedToMentions(playersQueue.playerIdsIndexed) },
          { name: 'Voting in progress', value: playersQueue.votingInProgress, inline: true },
          { name: 'Creating teams in progress', value: playersQueue.creatingTeamsInProgress, inline: true },
          { name: 'Lobby Ready', value: playersQueue.readyToJoin, inline: true },
        ],
      },
    })
  }
}

function registerRemakeVote(queue, voterId) {
  if (queue.playersWhoRemakeVoted[voterId]) return { counted: false, total: queue.remakeVotes }
  queue.playersWhoRemakeVoted[voterId] = true
  queue.remakeVotes += 1
  return { counted: true, total: queue.remakeVotes }
}

function requiredRemakeVotes() {
  return Math.ceil(REQUIRED_PLAYERS / 2)  // simple majority
}

module.exports = {
  determinePlayerQueue,
  deletePlayerQueue,
  removeOfflinePlayerFromQueue,
  kickPlayer,
  resetPlayerQueue,

  // Active match flow
  registerActiveMatch,
  clearActiveMatch,
  findActiveMatchQueueByPlayer,

  // Remake
  registerRemakeVote,
  requiredRemakeVotes,

  // Optional helpers
  listQueues,

  // Keepalive exports
  startKeepAlive,
  cancelKeepAlive,
  cancelAllKeepAlive,
  announceToQueueChannel,
}
