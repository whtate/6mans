// onHandlers/message.js

// Actions (direct imports to avoid circular dependency)
const enterQueue      = require('../actions/enterQueue')
const leaveQueue      = require('../actions/leaveQueue')
const getQueueStatus  = require('../actions/getQueueStatus')
const getVoteStatus   = require('../actions/getVoteStatus')
const submitVote      = require('../actions/submitVote')
const sendCommandList = require('../actions/sendCommandList')
const kickPlayer      = require('../actions/kickPlayer')

// DB helpers
const {
  getStats, upsertPlayer, getLeaderboard,
  recordResult, getLobbyHistory, getUserHistory, getLastMatches
} = require('../db')

// Queue manager
const {
  determinePlayerQueue,
  findActiveMatchQueueByPlayer,
  clearActiveMatch,
  registerRemakeVote,
  requiredRemakeVotes,
  resetPlayerQueue,
  listQueues,
} = require('../utils/managePlayerQueues')

// Commands map
const { commandToString, validCommandCheck } = require('../utils/commands')

// Env
const { NODE_ENV, channelName, debugLogs } = process.env

const REQUIRED_PLAYERS =
  Number.isFinite(parseInt(process.env.REQUIRED_PLAYERS, 10))
    ? parseInt(process.env.REQUIRED_PLAYERS, 10)
    : 6

const BRAND = process.env.lobbyName || 'in-house 6mans'

// ---------- helpers ----------

function toIds(arr) {
  return (arr || []).map(p => (typeof p === 'string' ? p : p?.id)).filter(Boolean)
}

function getTeamIdsFromQueue(queue) {
  if (Array.isArray(queue?.teamA) && Array.isArray(queue?.teamB)) {
    return { ok: true, teamAIds: toIds(queue.teamA), teamBIds: toIds(queue.teamB), labels: { A: 'A', B: 'B' } }
  }
  if (queue?.teams?.blue?.players && queue?.teams?.orange?.players) {
    return { ok: true, teamAIds: toIds(queue.teams.blue.players), teamBIds: toIds(queue.teams.orange.players), labels: { A: 'blue', B: 'orange' } }
  }
  if (Array.isArray(queue?.teams?.A) && Array.isArray(queue?.teams?.B)) {
    return { ok: true, teamAIds: toIds(queue.teams.A), teamBIds: toIds(queue.teams.B), labels: { A: 'A', B: 'B' } }
  }
  if (queue?.activeMatch) {
    return { ok: true, teamAIds: toIds(queue.activeMatch.teamAIds), teamBIds: toIds(queue.activeMatch.teamBIds), labels: { A: 'A', B: 'B' } }
  }
  return { ok: false }
}

async function deleteTeamVoiceChannels(queue, guild) {
  try {
    const ids = [
      queue?.teams?.blue?.voiceChannelID,
      queue?.teams?.orange?.voiceChannelID,
    ].filter(Boolean)

    for (const id of ids) {
      let ch = null
      try {
        if (!ch && guild?.channels?.cache?.get) ch = guild.channels.cache.get(id)
        if (!ch && guild?.channels?.get)        ch = guild.channels.get(id)
      } catch (e) {}

      if (!ch || typeof ch.delete !== 'function') continue
      try {
        await ch.delete('6mans: match completed / remade — cleaning up team voice channels')
      } catch (e) {
        console.error('Failed to delete voice channel', id, e && e.message)
      }
    }
  } catch (e) {
    console.error('deleteTeamVoiceChannels error', e)
  }
}

// ---------- handler ----------

module.exports = async (eventObj, botUser = { id: undefined }) => {
  const msg = eventObj.content.trim()
  const msgLower = msg.toLowerCase()
  const type = eventObj.channel.type
  const isCommand = msgLower.startsWith('!')
  const authorId = eventObj.author.id
  const guildId = eventObj.guild?.id
  const channel = eventObj.channel
  const guild = eventObj.guild

  const commonLogCheck = debugLogs === 'true' && authorId !== botUser.id

  if (channelName && channel.name !== channelName) {
    if (commonLogCheck) {
      console.log('The user is typing on a different channel, disregarding message')
      console.log(channel.name + ' !== ' + channelName)
    }
    return
  }

  if (!isCommand) {
    if (commonLogCheck) console.log('The user is not typing a 6mans command, disregarding message')
    return
  }

  if (NODE_ENV !== 'development' && type === 'dm') {
    if (commonLogCheck) console.log('The user is direct messaging the bot, disregarding message')
    return
  }

  if (authorId === botUser.id) return

  // parse command
  const [rawCommand, ...rest] = msgLower.split(/\s+/)
  const command = rawCommand
  const playerId = eventObj.author.id

  // Proactively capture/refresh usernames (author + mentions)
  try {
    await upsertPlayer({
      guildId,
      userId: eventObj.author.id,
      username: eventObj.author.username
    })
    eventObj.mentions?.users?.forEach?.(u => {
      upsertPlayer({ guildId, userId: u.id, username: u.username }).catch(()=>{})
    })
  } catch (e) {
    console.error('upsertPlayer (author/mentions) failed', e?.message || e)
  }

  // Determine queue for join-like commands
  let queue = determinePlayerQueue(playerId, command, guildId)

  const nonQueueCommands = new Set([
    commandToString.stats,
    '!leaderboard', commandToString.leaderboard,
    commandToString.help,
    commandToString.report,
    commandToString.lobbyhistory, '!lh', '!lobby', '!lobby-history',
    commandToString.playerhistory,
    commandToString.lastmatch, '!lastmatch', '!last-match',
    commandToString.remake,
    commandToString.status,
    commandToString.votestatus,
    commandToString.kick,
  ])

  if (isCommand && !queue && validCommandCheck[command] && !nonQueueCommands.has(command)) {
    channel.send(`You have not entered the queue <@${playerId}>. Type ${commandToString.queue} to join!`)
    return
  }

  const resolveQueueForView = () => {
    if (queue) return queue
    const qs = listQueues(guildId) || []
    return qs.length ? qs[qs.length - 1] : null
  }

  switch (command) {
    // queue flow
    case commandToString.queue:
    case '!queue':
      enterQueue(eventObj, queue)
      break

    case commandToString.leave:
      leaveQueue(eventObj, queue)
      break

    case commandToString.status: {
      const q = resolveQueueForView()
      getQueueStatus(eventObj, q)
      break
    }

    case commandToString.votestatus: {
      const q = resolveQueueForView()
      getVoteStatus(eventObj, q)
      break
    }

    case commandToString.r:
    case commandToString.c:
      submitVote(eventObj, queue)
      break

    case commandToString.help:
      sendCommandList(eventObj)
      break

    case commandToString.kick:
      kickPlayer(eventObj, queue || resolveQueueForView() || { players: [], playerIdsIndexed: {}, lobby: { name: 'Lobby' } })
      break

    // stats
    case commandToString.stats: {
      const target = eventObj.mentions.users.first() || eventObj.author
      await upsertPlayer({ guildId, userId: target.id, username: target.username })
      const s = await getStats({ guildId, userId: target.id })
      if (!s || !s.life) return channel.send(`No stats yet for <@${target.id}>`)
      const monthW = s.month.wins || 0
      const monthL = s.month.losses || 0
      const monthD = s.month.mmr_delta || 0
      const life = s.life
      return channel.send(
        `**${life.username}**\n` +
        `**This month:** W **${monthW}** / L **${monthL}** | ΔMMR **${monthD >= 0 ? '+' : ''}${monthD}**\n` +
        `**Lifetime:**  MMR **${life.mmr}** | W **${life.wins}** / L **${life.losses}**`
      )
    }

    // ---------- LEADERBOARD (code block, resolve numeric usernames to names if possible) ----------
    case commandToString.leaderboard:
    case '!leaderboard': {
      const arg = (rest[0] || '').trim();
      let limit = 10;
      if (/^all$/i.test(arg)) {
        limit = null;
      } else if (/^\d+$/.test(arg)) {
        limit = Math.min(parseInt(arg, 10), 2000);
      }

      const excludeUserIds = (process.env.LEADERBOARD_EXCLUDE_USER_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean)
      const excludeUsernames = (process.env.LEADERBOARD_EXCLUDE_USERNAMES || '')
        .split(',').map(s => s.trim()).filter(Boolean)
      const minGames = Number.isFinite(parseInt(process.env.LEADERBOARD_MIN_GAMES, 10))
        ? parseInt(process.env.LEADERBOARD_MIN_GAMES, 10) : 0

      const rows = await getLeaderboard({ guildId, limit, excludeUserIds, excludeUsernames, minGames })
      if (!rows.length) return channel.send('No players found.')

      const header =
        `**Leaderboard by MMR (${limit ? `Top ${rows.length}` : `All ${rows.length}`})**\n` +
        '```' + '\n' +
        '#  NAME                 W   L   MMR  ΔMMR\n' +
        '----------------------------------------------'
      const lines = rows.map((r, i) => {
        let display = r.username
        if (/^\d{16,}$/.test(display || '')) {
          const mem = guild?.members?.cache?.get?.(r.user_id)
          display = mem?.user?.username || r.user_id
        }
        const rank = String(i + 1).padStart(2, ' ')
        const name = String(display).padEnd(20, ' ')
        const w    = String(r.month_wins || 0).padStart(3, ' ')
        const l    = String(r.month_losses || 0).padStart(3, ' ')
        const mmr  = String(r.lifetime_mmr || 0).padStart(4, ' ')
        const d    = String((r.month_mmr_delta || 0)).padStart(5, ' ')
        return `${rank} ${name} ${w} ${l} ${mmr} ${d}`
      })
      return channel.send([header, ...lines, '```'].join('\n'))
    }

    // report (still !report a|b)
    case commandToString.report: {
      const arg = rest[0]?.toLowerCase()
      if (!['a','b'].includes(arg)) return channel.send('Usage: !report a | !report b')
      const winner = arg.toUpperCase()

      if (!queue) queue = findActiveMatchQueueByPlayer(guildId, authorId)
      if (!queue) return channel.send('No active match found to report for.')

      const extracted = getTeamIdsFromQueue(queue)
      if (!extracted.ok) return channel.send('Could not determine teams. Make sure teams are created.')
      const { teamAIds, teamBIds, labels } = extracted

      const perTeam = Math.floor(REQUIRED_PLAYERS / 2)
      if (teamAIds.length !== perTeam || teamBIds.length !== perTeam) {
        return channel.send(`Teams not complete yet. Expected ${perTeam} per team.`)
      }

      const isParticipant = teamAIds.includes(authorId) || teamBIds.includes(authorId)
      if (!isParticipant) return channel.send('Only players in this match can report the result.')

      try {
        const { matchId, deltaA, deltaB } = await recordResult({
          guildId,
          teamAIds,
          teamBIds,
          winner,
          reporterUserId: authorId,
          lobbyName: queue?.lobby?.name || null,
          lobbyRegion: queue?.lobby?.region || null,
          lobbySeries: queue?.lobby?.series || null,
        })

        await deleteTeamVoiceChannels(queue, eventObj.guild)

        clearActiveMatch(queue)
        resetPlayerQueue(queue.lobby.id)

        return channel.send(
          `**Match #${matchId} recorded**\n` +
          `Winner: Team ${winner} (${labels ? labels[winner] : winner})\n` +
          `Team A ΔMMR ${deltaA >= 0 ? '+' : ''}${deltaA}, Team B ΔMMR ${deltaB >= 0 ? '+' : ''}${deltaB}\n` +
          `Lobby: ${queue?.lobby?.name || 'n/a'}\n` +
          `Reported by: <@${authorId}>\n\n` +
          `Lobby reset. Players can queue again immediately.`
        )
      } catch (e) {
        console.error('report error', e)
        return channel.send('Failed to record result. Check logs.')
      }
    }

    // remake
    case commandToString.remake: {
      if (!queue) queue = findActiveMatchQueueByPlayer(guildId, authorId)
      if (!queue) return channel.send('No active lobby found to remake.')

      const allIds = queue?.activeMatch
        ? [...queue.activeMatch.teamAIds, ...queue.activeMatch.teamBIds]
        : Object.keys(queue.playerIdsIndexed)

      if (!allIds.includes(authorId)) return channel.send('Only players in this lobby can vote to remake.')

      const { counted, total } = registerRemakeVote(queue, authorId)
      const need = requiredRemakeVotes()
      if (!counted) return channel.send(`You already voted to remake. Current votes: **${total}/${need}**.`)

      if (total >= need) {
        await deleteTeamVoiceChannels(queue, eventObj.guild)
        clearActiveMatch(queue)
        resetPlayerQueue(queue.lobby.id)
        return channel.send(`**Remake passed.** Lobby reset. Players can queue again now.`)
      }
      return channel.send(`Remake vote recorded. Current votes: **${total}/${need}**.`)
    }

    // LOBBY HISTORY (no hyphen) — auto mode
    case commandToString.lobbyhistory:
    case '!lh':
    case '!lobby':
    case '!lobby-history': {
      const rawArg = msg.slice(command.length).trim()
      let name = rawArg || ''

      if (!name) {
        if (queue?.lobby?.name) {
          name = queue.lobby.name
        } else {
          const latest = await getLastMatches({ guildId, limit: 1 })
          if (latest.length && latest[0].lobby_name) {
            name = latest[0].lobby_name
          } else {
            name = ''
          }
        }
      } else {
        const num = name.match(/^\s*(\d+)\s*$/)?.[1]
        if (num) name = `${BRAND} — Lobby #${num}`
      }

      const rows = await getLobbyHistory({ guildId, lobbyName: name || null, limit: 10 })
      if (!rows.length) {
        return channel.send(name ? `No matches found for lobby **${name}**.` : 'No matches found.')
      }

      const header =
        `**Recent Matches${name ? ` — ${name}` : ''}**\n` +
        '```' + '\n' +
        'ID   W  LOBBY                         WHEN' + '\n' +
        '--------------------------------------------------'
      const lines = rows.map(r => {
        const when = new Date(r.created_at).toLocaleString()
        const lobby = (r.lobby_name || '-').padEnd(28)
        return `${String(r.id).padEnd(4)} ${r.winner}  ${lobby} ${when}`
      })
      return channel.send([header, ...lines, '```'].join('\n'))
    }

    // PLAYER HISTORY (kept as !history)
    case commandToString.playerhistory: {
      const target = eventObj.mentions.users.first() || eventObj.author
      const rows = await getUserHistory({ guildId, userId: target.id, limit: 10 })
      if (!rows.length) return channel.send(`No matches found for <@${target.id}>.`)

      const header =
        `**Recent Matches for ${target.username}**\n` +
        '```' + '\n' +
        'ID   W/L  ΔMMR  LOBBY                         WHEN' + '\n' +
        '--------------------------------------------------------'
      const lines = rows.map(r => {
        const when = new Date(r.created_at).toLocaleString()
        const wl = r.user_win ? 'W' : 'L'
        const delta = (r.user_delta || 0)
        const deltaStr = `${delta >= 0 ? '+' : ''}${delta}`.padStart(4)
        const lobby = (r.lobby_name || '-').padEnd(28)
        return `${String(r.id).padEnd(4)} ${wl}   ${deltaStr}  ${lobby} ${when}`
      })
      return channel.send([header, ...lines, '```'].join('\n'))
    }

    // LAST MATCH
    case commandToString.lastmatch:
    case '!lastmatch':
    case '!last-match': {
      const rows = await getLastMatches({ guildId, limit: 1 })
      if (!rows.length) return channel.send('No matches recorded yet.')
      const m = rows[0]
      const when = new Date(m.created_at).toLocaleString()
      return channel.send(
        `**Last Match #${m.id}** — ${when}\n` +
        `Winner: Team ${m.winner}\n` +
        `Lobby: ${m.lobby_name || 'n/a'}\n` +
        `Reported by: <@${m.reporter_user_id}>`
      )
    }

    default:
      return
  }
}
