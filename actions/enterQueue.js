// actions/enterQueue.js
const startVote = require('./startVote')
const { startKeepAlive } = require('../utils/managePlayerQueues')

module.exports = async (eventObj, queue) => {
  const { players, playerIdsIndexed } = queue
  const channel = eventObj.channel
  const playerId = eventObj.author.id
  const username = eventObj.author.username
  const dmPlayer = async (msg) => await eventObj.author.send(msg)

  // Already in queue
  if (playerIdsIndexed[playerId]) {
    return channel.send(`You are already in the queue <@${playerId}>`)
  }

  // Add player
  players.push({ id: playerId, username, dmPlayer })
  playerIdsIndexed[playerId] = true

  // Notify
  channel.send(`You have entered the queue <@${playerId}>`)

  // Start (or restart) the per-player keepalive timer
  startKeepAlive(queue, playerId)

  // Dev fill (if you use this mode)
  if (process.env.NODE_ENV === 'develop') {
    const fakePlayers = []
    for (let i = 0; i < 5; i++) {
      fakePlayers.push({ id: i, username: `bot-${i}`, dmPlayer })
      playerIdsIndexed[i] = true
    }
    players.push(...fakePlayers)
  }

  // Start vote if we hit 6
  if (Object.keys(playerIdsIndexed).length === 6) {
    startVote(eventObj, queue)
  }
}
