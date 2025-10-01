// actions/leaveQueue.js
const { commandToString } = require('../utils/commands')
const { cancelKeepAlive } = require('../utils/managePlayerQueues')

const REQUIRED_PLAYERS =
  Number.isFinite(parseInt(process.env.REQUIRED_PLAYERS, 10))
    ? parseInt(process.env.REQUIRED_PLAYERS, 10)
    : 6

module.exports = (eventObj, queue) => {
  if (!queue) return eventObj.channel.send('You are not in a queue.')

  const channel  = eventObj.channel
  const playerId = eventObj.author.id
  const size = Object.keys(queue.playerIdsIndexed || {}).length

  // Block leaving when full/in progress (use !remake)
  if (size >= REQUIRED_PLAYERS && (queue.votingInProgress || queue.creatingTeamsInProgress || queue.readyToJoin)) {
    return channel.send(
      `The lobby is full/in progress. You cannot leave now — use **${commandToString.remake || '!remake'}** to vote to cancel.`
    )
  }

  if (!queue.playerIdsIndexed[playerId]) {
    return channel.send('You are not in a queue.')
  }

  // Remove
  delete queue.playerIdsIndexed[playerId]
  if (Array.isArray(queue.players)) {
    queue.players = queue.players.filter(p => p.id !== playerId)
  }
  cancelKeepAlive(queue, playerId)

  channel.send(`You have left the queue <@${playerId}>`)
}
