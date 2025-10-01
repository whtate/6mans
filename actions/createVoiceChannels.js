// actions/createVoiceChannels.js
module.exports = async (eventObj, queue) => {
  const { lobby, teams } = queue
  const channel = eventObj.channel
  const guild = eventObj.guild

  try {
    if (!guild || !guild.available) {
      return channel.send('I do not have access to this guild right now.')
    }

    // Find the category under which to place the voice channels
    const parentCategory = guild.channels.find(
      ch => ch.type === 'category' && ch.name === process.env.categoryName
    )
    if (!parentCategory) {
      return channel.send(
        `Category **${process.env.categoryName}** not found. Create it first (exact name), then try again.`
      )
    }

    // @everyone role to set default denies
    const everyoneRole = guild.roles.find(r => r.name === '@everyone')
    if (!everyoneRole) {
      return channel.send('Could not find @everyone role. Check the bot permissions/roles.')
    }

    // --- CREATE BLUE ---
    // v11 signature: createChannel(name, type, permissionOverwrites, reason)
    // -> do NOT pass an options object here; set parent/limit after creation
    const blueVoice = await guild.createChannel(`${lobby.name}-blue`, 'voice')
    await blueVoice.setParent(parentCategory.id)
    await blueVoice.setUserLimit(3)

    // Deny for @everyone
    await blueVoice.overwritePermissions(everyoneRole, {
      CONNECT: false,
      SPEAK: false,
      CREATE_INSTANT_INVITE: false,
    })

    // Allow for each blue player
    for (const p of (teams.blue.players || [])) {
      if (!p || !p.id) continue
      await blueVoice.overwritePermissions(p.id, {
        CONNECT: true,
        SPEAK: true,
      })
    }

    // --- CREATE ORANGE ---
    const orangeVoice = await guild.createChannel(`${lobby.name}-orange`, 'voice')
    await orangeVoice.setParent(parentCategory.id)
    await orangeVoice.setUserLimit(3)

    await orangeVoice.overwritePermissions(everyoneRole, {
      CONNECT: false,
      SPEAK: false,
      CREATE_INSTANT_INVITE: false,
    })
    for (const p of (teams.orange.players || [])) {
      if (!p || !p.id) continue
      await orangeVoice.overwritePermissions(p.id, {
        CONNECT: true,
        SPEAK: true,
      })
    }

    // Save the channel IDs on the queue
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
    // Debug: show what's in queue after trying to create channels
    try {
      console.log('createVoiceChannel finished, queue:', JSON.stringify(queue, null, 2))
    } catch {}
  }
}
