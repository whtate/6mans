// actions/enterQueue.js
// Enhancements:
// - Replies with user's position in the queue (e.g., “you’re #4”)
// - Gentle no-op if already queued
// - Starts per-player keepalive (warn DM 5m before, kick at 1h unless they react)
// - Ensures the queue auto-disbands after inactivity (defaults to 2h; overridable via AUTODISBAND_MS)

const {
  startKeepAlive,
  announceToQueueChannel,
  deletePlayerQueue,
} = require('../utils/managePlayerQueues')

const REQUIRED_PLAYERS =
  Number.isFinite(parseInt(process.env.REQUIRED_PLAYERS, 10))
    ? parseInt(process.env.REQUIRED_PLAYERS, 10)
    : 6

// Default to 2 hours if not specified in env
const AUTODISBAND_MS =
  Number.isFinite(parseInt(process.env.AUTODISBAND_MS, 10))
    ? parseInt(process.env.AUTODISBAND_MS, 10)
    : (2 * 60 * 60 * 1000) // 2h

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel
  const playerId = eventObj.author.id

  // Standard queue shape we expect:
  // queue.players: [{ id, ... }]
  // queue.playerIdsIndexed: { [discordId]: true }
  queue.players = Array.isArray(queue.players) ? queue.players : []
  queue.playerIdsIndexed = queue.playerIdsIndexed || Object.create(null)

  // Already in the queue?
  if (queue.playerIdsIndexed[playerId]) {
    const position = (queue.players.findIndex(p => p && p.id === playerId) + 1) || 1
    return channel.send(
      `You’re already in the queue <@${playerId}> — **#${position}** (${queue.players.length}/${REQUIRED_PLAYERS}).`
    )
  }

  // Add player
  const player = { id: playerId }
  queue.players.push(player)
  queue.playerIdsIndexed[playerId] = true

  // Start per-player inactivity keepalive (DM warn + extend on reaction)
  try { startKeepAlive(queue, playerId) } catch (_) {}

  // Ensure / refresh an auto-disband timer at the queue level (2h default)
  // This is a safety net; if you already set AUTODISBAND_MS in managePlayerQueues,
  // this simply aligns the behavior to 2h by default unless overridden in env.
  try {
    if (queue.autoDisbandTimer) {
      clearTimeout(queue.autoDisbandTimer)
      queue.autoDisbandTimer = null
    }
    if (AUTODISBAND_MS > 0 && !queue.votingInProgress && !queue.activeMatch) {
      queue.autoDisbandTimer = setTimeout(() => {
        try {
          const count = Object.keys(queue.playerIdsIndexed || {}).length
          if (count < REQUIRED_PLAYERS && !queue.votingInProgress && !queue.activeMatch) {
            announceToQueueChannel(queue, `🕓 **${queue.lobby?.name || 'Lobby'}** expired due to inactivity. You can **!q** again.`)
            deletePlayerQueue(queue.lobby.id)
          }
        } catch (e) {
          console.error('autoDisbandTimer error', e)
        } finally {
          queue.autoDisbandTimer = null
        }
      }, AUTODISBAND_MS)
    }
  } catch (e) {
    console.error('Failed to set auto-disband timer', e)
  }

  // Position (1-based)
  const position = queue.players.length

  // Notify
  return channel.send(
    `Queued ✅ <@${playerId}> — you’re **#${position}** (${position}/${REQUIRED_PLAYERS}).`
  )
}
