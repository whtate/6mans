const playerNotInQueue = require('../utils/playerNotInQueue')
const { kickPlayer } = require('../utils/managePlayerQueues')

// Lightweight admin checker kept local to avoid repo-wide changes.
// Checks Discord perms, optional ADMIN_ROLE_ID, or comma-separated ADMIN_USER_IDS.
function isQueueAdmin(member) {
  if (!member) return false
  const has = (perm) =>
    (member.permissions && member.permissions.has && member.permissions.has(perm)) ||
    (typeof member.hasPermission === 'function' && member.hasPermission(perm))
  const byPerm = has('ADMINISTRATOR') || has('MANAGE_GUILD') || has('ManageGuild')
  const byRole = process.env.ADMIN_ROLE_ID
    ? (member.roles?.cache?.has?.(process.env.ADMIN_ROLE_ID) || member.roles?.has?.(process.env.ADMIN_ROLE_ID))
    : false
  const allow = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  return byPerm || byRole || allow.includes(member.id)
}

module.exports = async (eventObj, queue) => {
  const { players, lobby, playerIdsIndexed } = queue
  const channel = eventObj.channel
  const playerId = eventObj.author.id
  const member = eventObj.member
  const admin = isQueueAdmin(member)

  // If admin mentions a user, short-circuit to direct kick (no vote, no membership requirement)
  // Works whether or not the queue is full.
  const targetUser =
    eventObj.mentions && eventObj.mentions.users
      ? (typeof eventObj.mentions.users.first === 'function'
          ? eventObj.mentions.users.first()
          : (eventObj.mentions.users[0] || null))
      : null

  if (admin && targetUser) {
    const idx = players.findIndex(p => p && (p.id === targetUser.id))
    if (idx >= 0) {
      kickPlayer(idx, queue, (msg) => channel.send(msg))
      return channel.send(`👢 Kicked <@${targetUser.id}> from the queue (admin).`)
    }
    return channel.send(`User <@${targetUser.id}> is not in this queue.`)
  }

  // Non-admins must be in the queue to initiate kick vote
  if (!admin && playerNotInQueue({ playerId, channel, queue })) return

  // Non-admins can only start a kick vote when the queue is full
  if (!admin && players.length !== 6) {
    return channel.send(`A vote to kick cannot be started until the queue is full <@${playerId}>`)
  }

  // There are 6 players in the queue (or admin chose to run a vote anyway)
  // Create emoji dictionary
  const validReactions = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣']
  const emojiToIndex = {
    '0️⃣': 0,
    '1️⃣': 1,
    '2️⃣': 2,
    '3️⃣': 3,
    '4️⃣': 4,
    '5️⃣': 5,
  }

  // Create a list of all the kickable players
  const fields = []
  players.forEach((playerObj, playerIndex) => {
    fields.push({ name: playerObj.username, value: validReactions[playerIndex], inline: true })
  })

  // Send the vote to kick message
  const message = await channel.send({
    embed: {
      color: 2201331,
      title: `Lobby ${lobby.name} - Kick vote`,
      description:
        'A vote to kick has been started. Majority of the lobby will have to vote for the same player to be kicked.',
      fields,
    },
  })

  for (let i = 0; i < players.length; i++) {
    await message.react(validReactions[i])
  }

  const reactionCollector = message.createReactionCollector((reaction, user) => {
    return validReactions.includes(reaction.emoji.name) && playerIdsIndexed[user.id]
  })

  reactionCollector.on('collect', (reaction) => {
    // Add 2 to the majority because the Bot counts as 1 vote
    const majority = process.env.NODE_ENV === 'develop' ? 2 : players.length / 2 + 2
    const reactions = reaction.message.reactions

    reactions.forEach((reactionObj) => {
      if (Number(reactionObj.count) >= majority) {
        const playerToKickIndex = emojiToIndex[reactionObj.emoji.name]
        kickPlayer(playerToKickIndex, queue, (msg) => channel.send(msg))
        reactionCollector.stop()
      }
    })
  })
}
