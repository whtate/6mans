// actions/createLobbyInfo.js
// Announces the lobby host in-channel (without revealing name/password) and DMs all players with lobby info.
// Works for both team shapes (teams.blue/orange or teamA/teamB).

const { registerActiveMatch } = require('../utils/managePlayerQueues')

// Get the Discord client instance without creating a circular import
function getClient() {
  try { return require('../index') } catch { return null }
}

function getUser(client, id) {
  if (!client || !id) return null
  // v12+
  if (client.users?.cache?.get) return client.users.cache.get(id) || null
  // v11
  if (client.users?.get) return client.users.get(id) || null
  return null
}

function mention(id) {
  return /^\d+$/.test(id) ? `<@${id}>` : String(id)
}

function toIds(list) {
  return (list || [])
    .map(p => (typeof p === 'string' ? p : p?.id))
    .filter(Boolean)
}

function extractTeams(queue) {
  // supports multiple shapes
  if (queue?.teams?.blue?.players && queue?.teams?.orange?.players) {
    return {
      blueIds: toIds(queue.teams.blue.players),
      orangeIds: toIds(queue.teams.orange.players),
      labels: { A: 'blue', B: 'orange' },
    }
  }
  if (Array.isArray(queue?.teamA) && Array.isArray(queue?.teamB)) {
    return {
      blueIds: toIds(queue.teamA),
      orangeIds: toIds(queue.teamB),
      labels: { A: 'A', B: 'B' },
    }
  }
  if (Array.isArray(queue?.teams?.A) && Array.isArray(queue?.teams?.B)) {
    return {
      blueIds: toIds(queue.teams.A),
      orangeIds: toIds(queue.teams.B),
      labels: { A: 'A', B: 'B' },
    }
  }
  return null
}

function firstNonNull(...vals) {
  for (const v of vals) if (v != null) return v
  return null
}

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel
  const guild   = eventObj.guild
  const client  = getClient()

  // Basic lobby metadata (kept PRIVATE to DMs)
  const lobbyName   = firstNonNull(queue?.lobby?.name, queue?.lobby?.label, 'Lobby')
  const lobbyPass   = queue?.lobby?.password || '0000'
  const lobbyRegion = queue?.lobby?.region || process.env.lobbyRegion || 'Region'
  const lobbySeries = queue?.lobby?.series || process.env.lobbySeries || null

  const extracted = extractTeams(queue)
  if (!extracted) {
    await channel.send('Could not determine teams to prepare lobby info.')
    return
  }

  const { blueIds, orangeIds } = extracted
  const allIds = [...blueIds, ...orangeIds].filter(Boolean)

  // Choose/remember a host among the 6 players (prefer a captain if present, else random)
  let hostId = queue.hostUserId
  if (!hostId || !allIds.includes(hostId)) {
    const preferred = firstNonNull(queue?.teams?.blue?.captain?.id, queue?.teams?.orange?.captain?.id)
    hostId = (preferred && allIds.includes(preferred))
      ? preferred
      : allIds[Math.floor(Math.random() * allIds.length)]
    queue.hostUserId = hostId
  }

  // Resolve voice channel mentions if created (OK to display publicly)
  const blueVCId   = queue?.teams?.blue?.voiceChannelID
  const orangeVCId = queue?.teams?.orange?.voiceChannelID
  const blueVCRef   = blueVCId   ? `<#${blueVCId}>`   : '(to be created)'
  const orangeVCRef = orangeVCId ? `<#${orangeVCId}>` : '(to be created)'

  // PUBLIC: announce host ONLY (no name/password)
  const publicFields = [
    { name: 'Blue VC',   value: blueVCRef, inline: true },
    { name: 'Orange VC', value: orangeVCRef, inline: true },
  ]

  await channel.send({
    embed: {
      color: 3066993,
      title: `Lobby ready — host needed`,
      description:
        `**${mention(hostId)} please create the lobby** in-game and invite all players.\n` +
        `Everyone in this match has been sent the details via DM.\n\n` +
        `When the series is finished, **report the result with \`!report a\` or \`!report b\`**.`,
      fields: publicFields,
    },
  })

  // PRIVATE: DM every player the full lobby info (name + password)
  const dmText =
    `**Match is ready.**\n\n` +
    `**Host:** ${mention(hostId)}\n` +
    `**Lobby Name:** ${lobbyName}\n` +
    `**Password:** \`${lobbyPass}\`\n` +
    `**Region:** ${lobbyRegion}${lobbySeries ? `\n**Series:** ${lobbySeries}` : ''}\n\n` +
    `Join your voice channel:\n` +
    `• Blue: ${blueVCRef}\n` +
    `• Orange: ${orangeVCRef}\n\n` +
    `After the match, report with **!report a** or **!report b**.`

  for (const id of allIds) {
    try {
      const user = getUser(client, id)
      if (!user) continue
      const dm = await user.createDM()
      await dm.send(dmText)
    } catch (e) {
      // DM may fail due to privacy settings; ignore per-user errors
      console.error(`DM failed for ${id}:`, e && e.message)
    }
  }

  // Mark ready & register active match so players are free to !q after reporting
  try {
    queue.readyToJoin = true
    registerActiveMatch(queue, blueIds, orangeIds)
  } catch (e) {
    console.error('registerActiveMatch failed in createLobbyInfo:', e)
  }
}
