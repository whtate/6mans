// actions/createVoiceChannels.js
// Creates team voice channels using the v12+ options-object API,
// with a safe fallback to the old v11 API if needed.

module.exports = async (eventObj, queue) => {
  const { lobby, teams } = queue
  const channel = eventObj.channel
  const guild = eventObj.guild

  try {
    if (!guild || (guild.available === false)) {
      return channel.send('I do not have access to this guild right now.')
    }

    // Locate the parent category
    const parentCategory =
      (guild.channels?.cache && guild.channels.cache.find(ch => ch.type === 'category' && ch.name === process.env.categoryName)) ||
      (guild.channels && guild.channels.find && guild.channels.find(ch => ch.type === 'category' && ch.name === process.env.categoryName))

    if (!parentCategory) {
      return channel.send(
        `Category **${process.env.categoryName}** not found. Create it first (exact name), then try again.`
      )
    }

    // Everyone role
    const everyoneRole =
      (guild.roles?.everyone) ||
      (guild.roles?.cache && guild.roles.cache.find(r => r.name === '@everyone')) ||
      (guild.roles && guild.roles.find && guild.roles.find(r => r.name === '@everyone'))

    if (!everyoneRole) {
      return channel.send('Could not find @everyone role. Check the bot permissions/roles.')
    }

    // Collect player IDs for permission overwrites
    const blueIds = (teams.blue.players || []).map(p => p && p.id).filter(Boolean)
    const orangeIds = (teams.orange.players || []).map(p => p && p.id).filter(Boolean)

    // Helper to build overwrites for v12+
    const buildOverwrites = (allowIds = []) => {
      const base = [
        { id: everyoneRole.id, deny: ['CONNECT', 'SPEAK', 'CREATE_INSTANT_INVITE'] },
      ]
      for (const id of allowIds) base.push({ id, allow: ['CONNECT', 'SPEAK'] })
      return base
    }

    // Create a voice channel using v12+ API if available, else v11
    async function createVoice(name, allowIds) {
      // v12+:
      if (guild.channels?.create) {
        const vc = await guild.channels.create(name, {
          type: 'voice',
          parent: parentCategory.id,
          userLimit: 3,
          permissionOverwrites: buildOverwrites(allowIds),
          reason: '6mans team voice channel',
        })
        return vc
      }

      // v11 fallback:
      const vc = await guild.createChannel(name, 'voice')
      await vc.setParent(parentCategory.id)
      await vc.setUserLimit(3)

      // Deny for everyone
      await vc.overwritePermissions(everyoneRole, {
        CONNECT: false,
        SPEAK: false,
        CREATE_INSTANT_INVITE: false,
      })

      // Allow for each player
      for (const id of allowIds) {
        await vc.overwritePermissions(id, { CONNECT: true, SPEAK: true })
      }
      return vc
    }

    // Create both channels
    const blueVoice   = await createVoice(`${lobby.name}-blue`, blueIds)
    const orangeVoice = await createVoice(`${lobby.name}-orange`, orangeIds)

    // Save the channel IDs on the queue for later deletion
    teams.blue.voiceChannelID = blueVoice.id
    teams.orange.voiceChannelID = orangeVoice.id

    // Confirm
    channel.send(
      `Voice channels created:\n• <#${blueVoice.id}>\n• <#${orangeVoice.id}>`
    )
  } catch (err) {
    console.error('Failed to create voice channels:', err)
    channel.send('I could not create team voice channels. Check my permissions and try again.')
  } finally {
    try {
      console.log('createVoiceChannels finished, queue:', JSON.stringify({
        lobby: queue?.lobby, teams: {
          blue:   { vc: queue?.teams?.blue?.voiceChannelID, players: (queue?.teams?.blue?.players||[]).map(p=>p.id) },
          orange: { vc: queue?.teams?.orange?.voiceChannelID, players: (queue?.teams?.orange?.players||[]).map(p=>p.id) },
        }
      }, null, 2))
    } catch {}
  }
}
