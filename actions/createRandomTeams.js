const randomNumber = require('../utils/randomNumber')
const createVoiceChannels = require('./createVoiceChannels')
const createLobbyInfo = require('./createLobbyInfo')

module.exports = async (eventObj, queue) => {
  const { lobby, players, teams } = queue
  const channel = eventObj.channel

  // reflect state for !status / observers
  queue.votingInProgress = false
  queue.creatingTeamsInProgress = true
  queue.draft = null
  queue.status = 'creating-teams'

  // Tell the server that random mode was chosen
  await channel.send({
    embed: {
      color: 2201331,
      title: `Lobby ${lobby.name} - Random structure`,
      description: 'The vote resulted in random structure. You will receive a DM when the teams are automatially created.',
    },
  })

  // Defensive copies; don't mutate original players array reference while iterating
  const pool = Array.isArray(players) ? players.slice() : []

  // Clear existing team lists in case of re-entry
  teams.blue.players = []
  teams.orange.players = []

  // Create blue team
  while (teams.blue.players.length !== 3 && pool.length > 0) {
    const randomIndex = randomNumber(pool.length - 1)
    teams.blue.players.push(pool[randomIndex])
    pool.splice(randomIndex, 1)
  }

  // Create orange team
  while (teams.orange.players.length !== 3 && pool.length > 0) {
    const randomIndex = randomNumber(pool.length - 1)
    teams.orange.players.push(pool[randomIndex])
    pool.splice(randomIndex, 1)
  }

  // NEW: show the teams in the queue chat
  const mention = (id) => (/^\d+$/.test(id) ? `<@${id}>` : String(id))
  const fmtTeam = (arr) => arr.map(p => mention(p.id || p)).join(', ')
  await channel.send({
    embed: {
      color: 3066993,
      title: 'Teams are ready!',
      fields: [
        { name: 'Blue',   value: fmtTeam(teams.blue.players) || '(none)' },
        { name: 'Orange', value: fmtTeam(teams.orange.players) || '(none)' },
      ],
    },
  })

  // NEW: create voice channels before sending lobby info DMs
  try {
    await createVoiceChannels(eventObj, queue)
  } catch (e) {
    console.error('createVoiceChannels failed (random):', e)
    // proceed; lobby info DM will still go out
  }

  // Create/announce the lobby (DMs players, public host ping without password)
  try {
    await createLobbyInfo(eventObj, queue)
  } catch (e) {
    console.error('createLobbyInfo failed (random):', e)
  } finally {
    queue.creatingTeamsInProgress = false
  }
}
