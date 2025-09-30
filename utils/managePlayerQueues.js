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
  : (7 * 60 * 1000) // 7 minutes

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
  votes: {
    r: 0,
    c: 0,
    playersWhoVoted: {},
  },
  creatingTeamsInProgress: false,
  teams: {
    blue: {
      players: [],
      captain: undefined,
      voiceChannelID: undefined,
      voiceChannelHistory: {},
    },
    orange: {
      players: [],
      captain: undefined,
      voiceChannelID: undefined,
      voiceChannelHistory: {},
    },
  },
  readyToJoin: false,

  // Remake voting
  remakeVotes: 0,
  playersWhoRemakeVoted: {},
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
      password: randomstring.generate({ length: 3 }).toLowerCase(),
    },

    players: [],
    playerIdsIndexed: {},
    ...cloneDeep(queueResetValues),

    activeMatch: null,  // { teamAIds, teamBIds } once teams are formed
    createdAt: Date.now(),
    autoDisbandTimer: null,
  }

  // Start auto-disband timer (if lobby never fills)
  queue.autoDisbandTimer = setTimeout(() => {
    const count = Object.keys(queue.playerIdsIndexed).length
    if (count < REQUIRED_PLAYERS && !queue.votingInProgress && !queue.activeMatch) {
      // Disband silently – no W/L – players can requeue
      deletePlayerQueue(queue.lobby.id)
    }
  }, AUTODISBAND_MS)

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

// When teams/VCs are created, call this so players are free to re-queue
function registerActiveMatch(queue, teamAIds, teamBIds) {
  queue.activeMatch = { teamAIds: [...teamAIds], teamBIds: [...teamBIds] }
  queue.votingInProgress = false
  queue.creatingTeamsInProgress = false

  // Cancel auto-disband timer; match is in progress
  if (queue.autoDisbandTimer) {
    clearTimeout(queue.autoDisbandTimer)
    queue.autoDisbandTimer = null
  }

  // Free players from queue (so they can join another queue immediately)
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

function resetPlayerQueue(lobbyId) {
  for (const [, state] of guildStates) {
    const q = state.queues.find(q => q.lobby.id === lobbyId)
    if (!q) continue
    const preserved = {
      players: q.players,
      playerIdsIndexed: q.playerIdsIndexed,
      lobby: q.lobby,
      guildId: q.guildId,
      createdAt: q.createdAt,
    }
    Object.assign(q, preserved, cloneDeep(queueResetValues))
    // restart disband timer
    if (q.autoDisbandTimer) clearTimeout(q.autoDisbandTimer)
    q.autoDisbandTimer = setTimeout(() => {
      const count = Object.keys(q.playerIdsIndexed).length
      if (count < REQUIRED_PLAYERS && !q.votingInProgress && !q.activeMatch) {
        deletePlayerQueue(q.lobby.id)
      }
    }, AUTODISBAND_MS)
    return
  }
}

function kickPlayer(playerIndex, queue, messageChannel) {
  const playerObj = queue.players[playerIndex]
  if (!playerObj) return
  const playerId = playerObj.id
  delete queue.playerIdsIndexed[playerId]
  queue.players.splice(playerIndex, 1)
  if (messageChannel) {
    messageChannel(`<@${playerId}> has been kicked. You can check the lobby status with ${commandToString.status}`)
  }
  resetPlayerQueue(queue.lobby.id)
}

function removeOfflinePlayerFromQueue({ playerId, playerChannels, guildId }) {
  let playersQueue = findPlayersQueue(guildId, playerId)
  if (!playersQueue) {
    // Check active matches; if player is in an active match, ignore (not in queue anymore)
    const state = getGuildState(guildId)
    if (state.activeByPlayer.get(playerId)) return
    return
  }

  playersQueue.players = playersQueue.players.filter(p => p.id !== playerId)
  delete playersQueue.playerIdsIndexed[playerId]

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
}
