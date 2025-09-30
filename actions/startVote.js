// actions/startVote.js
const playerIdsIndexedToMentions = require('../utils/playerIdsIndexedToMentions')
const { commandToString } = require('../utils/commands')
const { registerActiveMatch } = require('../utils/managePlayerQueues')

const REQUIRED_PLAYERS =
  Number.isFinite(parseInt(process.env.REQUIRED_PLAYERS, 10))
    ? parseInt(process.env.REQUIRED_PLAYERS, 10)
    : 6

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel
  const { playerIdsIndexed, lobby } = queue

  // DEV MODE: auto-pick captains & teams, then free players to re-queue while keeping an active match
  if (process.env.NODE_ENV === 'development') {
    const players = Array.isArray(queue.players) ? [...queue.players] : []
    if (players.length < REQUIRED_PLAYERS) {
      await channel.send(`Dev mode: need ${REQUIRED_PLAYERS} players to start, but only have ${players.length}.`)
      return
    }

    // shuffle
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[players[i], players[j]] = [players[j], players[i]]
    }

    // captains
    const captainA = players[0]
    const captainB = players[1]
    const rest = players.slice(2)

    const teamA = [captainA]
    const teamB = [captainB]
    rest.forEach((p, idx) => (idx % 2 === 0 ? teamA.push(p) : teamB.push(p)))

    queue.teamA = teamA.map(p => ({ id: p.id, username: p.username }))
    queue.teamB = teamB.map(p => ({ id: p.id, username: p.username }))

    // Mark as active match & free players from queue so they can re-queue
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
          { name: 'Team A Captain', value: /^\d+$/.test(captainA.id) ? `<@${captainA.id}>` : captainA.username, inline: false },
          { name: 'Team A Roster', value: listNoCaptain(queue.teamA), inline: false },
          { name: 'Team B Captain', value: /^\d+$/.test(captainB.id) ? `<@${captainB.id}>` : captainB.username, inline: false },
          { name: 'Team B Roster', value: listNoCaptain(queue.teamB), inline: false },
          { name: 'Next step', value: `Type **${commandToString.report || '!report'} a** or **${commandToString.report || '!report'} b** to record the result.` },
        ],
      },
    })
    return
  }

  // PRODUCTION: your existing vote-based flow
  queue.votingInProgress = true

  await channel.send(playerIdsIndexedToMentions(playerIdsIndexed))
  await channel.send({
    embed: {
      color: 2201331,
      title: `Lobby ${lobby.name} - ${REQUIRED_PLAYERS} players found`,
      description: 'Please vote for your desired team structure.',
      fields: [
        { name: 'Vote for random teams', value: commandToString.r, inline: true },
        { name: 'Vote for captains', value: commandToString.c, inline: true },
        { name: 'Vote Status', value: `You can check the vote status by typing ${commandToString.votestatus}` },
      ],
    },
  })
}
