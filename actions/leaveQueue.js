// actions/leaveQueue.js
const { commandToString } = require('../utils/commands')
const { cancelKeepAlive, announceToQueueChannel, deletePlayerQueue } = require('../utils/managePlayerQueues')

const REQUIRED_PLAYERS =
  Number.isFinite(parseInt(process.env.REQUIRED_PLAYERS, 10))
    ? parseInt(process.env.REQUIRED_PLAYERS, 10)
    : 6

module.exports = (eventObj, queue) => {
  if (!queue) return eventObj.channel.send('You are not in a queue.')

  const channel  = eventObj.channel
  const playerId = eventObj.author.id

  const size = Object.keys(queue.playerIdsIndexed || {}).length

  // Once lobby hits required size and is in progress, block leaving
  if (size >= REQUIRED_PLAYERS && (queue.votingInProgress || queue.creatingTeamsInProgress || queue.readyToJoin)) {
    return channel.send(
      `The lobby is full/in progress. You cannot leave now — use **${commandToString.remake || '!remake'}** to vote to cancel.`
    )
  }

  if (!queue.playerIdsIndexed || !queue.playerIdsIndexed[playerId]) {
    return channel.send('You are not in a queue.')
  }

  // Remove player from queue
  delete queue.playerIdsIndexed[playerId]
  if (Array.isArray(queue.players)) {
    queue.players = queue.players.filter(p => p.id !== playerId)
  }

  // Stop any keepalive for this user
  try { cancelKeepAlive(queue, playerId) } catch (_) {}

  // If no one is left, expire and disband (mirrors removeOfflinePlayerFromQueue behavior)
  const remaining = Object.keys(queue.playerIdsIndexed || {}).length
  if (remaining === 0) {
    try {
      queue.status = 'expired'
      queue.expiresAt = new Date().toISOString()
    } catch (_) {}
    try {
      announceToQueueChannel(queue, `🕓 **${queue.lobby.name}** expired (everyone left).`)
    } catch (_) {}
    try { deletePlayerQueue(queue.lobby.id) } catch (_) {}
    return channel.send(`You have left the queue <@${playerId}> — the lobby is now **disbanded**.`)
  }

  // Normal confirmation
  channel.send(`You have left the queue <@${playerId}>`)
}
