// actions/startVote.js
const playerIdsIndexedToMentions = require('../utils/playerIdsIndexedToMentions')
const { commandToString } = require('../utils/commands')
const { registerActiveMatch } = require('../utils/managePlayerQueues')

const REQUIRED_PLAYERS =
  Number.isFinite(parseInt(process.env.REQUIRED_PLAYERS, 10))
    ? parseInt(process.env.REQUIRED_PLAYERS, 10)
    : 6

// Default: 7 minutes (you asked to extend from 4 → 7)
const VOTE_TIMEOUT_MS =
  Number.isFinite(parseInt(process.env.VOTE_TIMEOUT_MS, 10))
    ? parseInt(process.env.VOTE_TIMEOUT_MS, 10)
    : (7 * 60 * 1000)

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel
  const { playerIdsIndexed, lobby } = queue

  // ---------------- DEV MODE: auto-create teams for fast testing ----------------
  if (process.env.NODE_ENV === 'development') {
    const players = Array.isArray(queue.players) ? [...queue.players] : []
    if (players.length < REQUIRED_PLAYERS) {
      await channel.send(`Dev mode: need ${REQUIRED_PLAYERS} players to start, but only have ${players.length}.`)
      return
    }

    // simple shuffle
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[players[i], players[j]] = [players[j], players[i]]
    }

    // captains (A/B) + snake-ish fill
    const captainA = players[0]
    const captainB = players[1]
    const rest = players.slice(2)
    const teamA = [captainA], teamB = [captainB]
    rest.forEach((p, idx) => (idx % 2 === 0 ? teamA.push(p) : teamB.push(p)))

    // store on queue (legacy arrays for compatibility)
    queue.teamA = teamA.map(p => ({ id: p.id, username: p.username }))
    queue.teamB = teamB.map(p => ({ id: p.id, username: p.username }))

    // mark active match so players can requeue
    registerActiveMatch(
      queue,
      queue.teamA.map(p => p.id),
      queue.teamB.map(p => p.id)
    )

    const listNoCaptain = (team) =>
      team.slice(1).map(p => `- ${/^\d+$/.test(p.id) ? `<@${p.id}>` : p.username}`).join('\n') || '- (no picks)'

    await channel.send({
      embed: {
        color: 2201331,
        title: `Dev mode: Teams created for ${lobby?.name || 'Lobby'}`,
        description: `Captains & teams have been auto-selected for testing.`,
        fields: [
          { name: 'Team A Captain', value: /^\d+$/.test(captainA.id) ? `<@${captainA.id}>` : captainA.username },
          { name: 'Team A Roster', value: listNoCaptain(queue.teamA) },
          { name: 'Team B Captain', value: /^\d+$/.test(captainB.id) ? `<@${captainB.id}>` : captainB.username },
          { name: 'Team B Roster', value: listNoCaptain(queue.teamB) },
          { name: 'Next step', value: `Type **${commandToString.report || '!report'} a** or **${commandToString.report || '!report'} b** to record the result.` },
        ],
      },
    })
    return
  }

  // ---------------- PRODUCTION: vote-based flow with timeout ----------------
  queue.votingInProgress = true
  queue.creatingTeamsInProgress = false
  queue.votes = { r: 0, c: 0, playersWhoVoted: {} }

  // clear previous timer
  if (queue._voteTimeout) {
    clearTimeout(queue._voteTimeout)
    queue._voteTimeout = null
  }

  const totalPlayers = Object.keys(playerIdsIndexed || {}).length
  const needed = Math.ceil(totalPlayers / 2) || 3

  await channel.send(playerIdsIndexedToMentions(playerIdsIndexed))
  await channel.send({
    embed: {
      color: 2201331,
      title: `Lobby ${lobby.name} - ${totalPlayers} players found`,
      description:
        `Vote for your desired team structure. First to **${needed}** wins.\n` +
        `No decision in **${Math.round(VOTE_TIMEOUT_MS/60000)} minutes** → lobby auto-disbands.`,
      fields: [
        { name: 'Random teams', value: commandToString.r, inline: true },
        { name: 'Captains',     value: commandToString.c, inline: true },
        { name: 'Vote Status',  value: `Type ${commandToString.votestatus}` },
      ],
    },
  })

  // schedule auto-disband if no decision
  queue._voteTimeout = setTimeout(() => {
    if (!queue.votingInProgress) return
    queue.votingInProgress = false
    queue._voteTimeout = null

    // mark queue expired so !status can show it clearly
    queue.status = 'expired'
    queue.expiresAt = new Date().toISOString()

    // banner in channel
    channel.send({
      embed: {
        color: 15158332, // red
        title: `Lobby ${lobby?.name || 'Lobby'} — Queue expired`,
        description: `No decision reached in time. The queue has been **disbanded**. Type **${commandToString.queue || '!q'}** to start a fresh one.`
      }
    })

    const { deletePlayerQueue } = require('../utils/managePlayerQueues')
    deletePlayerQueue(queue.lobby.id)
  }, VOTE_TIMEOUT_MS)
}
