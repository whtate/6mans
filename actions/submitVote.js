// actions/submitVote.js
const createRandomTeams  = require('./createRandomTeams')
const createCaptainTeams = require('./createCaptainTeams')

module.exports = async (eventObj, queue) => {
  const channel  = eventObj.channel
  const authorId = eventObj.author.id
  const raw      = eventObj.content.trim().toLowerCase()

  if (!queue) return channel.send('No active lobby found.')
  if (!queue.votingInProgress) return channel.send('No vote in progress right now.')

  // ensure vote state exists
  if (!queue.votes) {
    queue.votes = { r: 0, c: 0, playersWhoVoted: {} }
  }

  // only lobby members can vote
  if (!queue.playerIdsIndexed || !queue.playerIdsIndexed[authorId]) {
    return channel.send('Only players in this lobby can vote.')
  }

  // prevent double-voting
  if (queue.votes.playersWhoVoted[authorId]) {
    return channel.send('You already voted. Type !votestatus to see the tally.')
  }

  // accept "!r" or "!c"
  let choice = null
  if (raw.startsWith('!r')) choice = 'r'
  if (raw.startsWith('!c')) choice = 'c'
  if (!choice) return channel.send('Vote with **!r** (random) or **!c** (captains).')

  // record vote
  queue.votes.playersWhoVoted[authorId] = true
  queue.votes[choice] = (queue.votes[choice] || 0) + 1

  const totalPlayers = Object.keys(queue.playerIdsIndexed || {}).length || 6
  const needed = Math.ceil(totalPlayers / 2) // e.g., 6 -> 3

  const r = queue.votes.r || 0
  const c = queue.votes.c || 0

  await channel.send(`Vote recorded. Random: **${r}** | Captains: **${c}** (need **${needed}**)`)

  // helper to finalize
  const decide = async (mode) => {
    queue.votingInProgress = false
    if (queue._voteTimeout) {
      clearTimeout(queue._voteTimeout)
      queue._voteTimeout = null
    }

    if (mode === 'r') {
      // NEW: clear any stale draft state and optionally indicate we're creating teams
      queue.draft = null
      queue.status = 'creating-teams' // informational only; won't break existing flows
      await channel.send('**Random teams** selected by vote.')
      return createRandomTeams(eventObj, queue)
    } else {
      // NEW: seed a minimal draft state so !status can show "Currently picking"
      queue.draft = queue.draft || { mode: 'captains', currentCaptainId: null, picks: [] }
      queue.status = 'drafting'
      await channel.send('**Captains** selected by vote.')
      return createCaptainTeams(eventObj, queue)
    }
  }

  // decide immediately on threshold
  if (r >= needed) return decide('r')
  if (c >= needed) return decide('c')

  // all votes in but no majority → random pick
  if (r + c >= totalPlayers) {
    await channel.send('Votes tied. Picking at random…')
    return decide(Math.random() < 0.5 ? 'r' : 'c')
  }
}
