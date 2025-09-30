// actions/enterQueue.js
const startVote = require('./startVote')
const { upsertPlayer } = require('../db') // actions -> root, so ../

const REQUIRED_PLAYERS =
  Number.isFinite(parseInt(process.env.REQUIRED_PLAYERS, 10))
    ? parseInt(process.env.REQUIRED_PLAYERS, 10)
    : 6

module.exports = async function enterQueue(eventObj, queue) {
  const { players, playerIdsIndexed } = queue
  const channel   = eventObj.channel
  const playerId  = eventObj.author.id
  const username  = eventObj.author.username
  const guildId   = eventObj.guild.id
  const dmPlayer  = async (msg) => await eventObj.author.send(msg)

  // Ensure the player exists in DB with defaults (MMR 1000, 0–0)
  await upsertPlayer({ guildId, userId: playerId, username })

  // Already in queue?
  if (playerIdsIndexed[playerId]) {
    return channel.send(`You are already in the queue <@${playerId}>`)
  }

  // Not in queue: add them
  players.push({ id: playerId, username, dmPlayer })
  playerIdsIndexed[playerId] = true

  // --- DEV AUTOFILL ---
  // If you're in development mode, auto-fill with fake players so you don't need 5 friends.
  if (process.env.NODE_ENV === 'development') {
    // How many more do we need to reach REQUIRED_PLAYERS?
    const currentCount = Object.keys(playerIdsIndexed).length
    const toAdd = Math.max(0, REQUIRED_PLAYERS - currentCount)
    if (toAdd > 0) {
      const fakePlayers = []
      // Use negative IDs to avoid colliding with real Discord user IDs
      for (let i = 1; i <= toAdd; i++) {
        const fakeId = `dev-bot-${i}`
        fakePlayers.push({ id: fakeId, username: `bot-${i}`, dmPlayer })
        playerIdsIndexed[fakeId] = true
      }
      players.push(...fakePlayers)
    }
  }

  // Notify
  channel.send(`You have entered the queue <@${playerId}>`)

  // Check if we reached the required number of players
  const totalQueued = Object.keys(playerIdsIndexed).length
  if (totalQueued >= REQUIRED_PLAYERS) {
    // Start the voting phase
    startVote(eventObj, queue)
  }
}
