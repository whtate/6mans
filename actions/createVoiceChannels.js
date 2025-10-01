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

    // Helper to set perms for a team
    const applyTeamPermissions = async (voiceChan, playersArr = []) => {
      // Deny for @everyone
      await voiceChan.overwritePermissions(everyoneRole, {
        CONNECT: false,
        SPEAK: false,
        CREATE_INSTANT_INVITE: false,
      })
      // Allow for each player on that team
      for (const p of (playersArr || [])) {
        if (!p || !p.id) continue
        await voiceChan.overwritePermissions(p.id, {
          CONNECT: true,
          SPEAK: true,
        })
      }
    }

    // --- CREATE BLUE ---
    // Prefer your original v11 signature: createChannel(name, type)
    // If unavailable (v12+), fallback to guild.channels.create(name, { type })
    let blueVoice
    if (typeof guild.createChannel === 'function') {
      blueVoice = await guild.createChannel(`${lobby.name}-blue`, 'voice')
      await blueVoice.setParent(parentCategory.id)
      await blueVoice.setUserLimit(3)
      await applyTeamPermissions(blueVoice, teams.blue && teams.blue.players)
    } else if (guild.channels && typeof guild.channels.create === 'function') {
      // v12/v13 path
      blueVoice = await guild.channels.create(`${lobby.name}-blue`, { type: 'GUILD_VOICE' })
      await blueVoice.setParent(parentCategory.id)
      await blueVoice.setUserLimit(3)
      // Permissions API changed names across versions; keep overwritePermissions for your runtime
      await applyTeamPermissions(blueVoice, teams.blue && teams.blue.players)
    } else {
      return channel.send('This Discord.js version is not supported for creating channels.')
    }

    // --- CREATE ORANGE ---
    let orangeVoice
    if (typeof guild.createChannel === 'function') {
      orangeVoice = await guild.createChannel(`${lobby.name}-orange`, 'voice')
      await orangeVoice.setParent(parentCategory.id)
      await orangeVoice.setUserLimit(3)
      await applyTeamPermissions(orangeVoice, teams.orange && teams.orange.players)
    } else if (guild.channels && typeof guild.channels.create === 'function') {
      orangeVoice = await guild.channels.create(`${lobby.name}-orange`, { type: 'GUILD_VOICE' })
      await orangeVoice.setParent(parentCategory.id)
      await orangeVoice.setUserLimit(3)
      await applyTeamPermissions(orangeVoice, teams.orange && teams.orange.players)
    }

    // Save the channel IDs on the queue
    teams.blue.voiceChannelID = blueVoice.id
    teams.orange.voiceChannelID = orangeVoice.id

    // Optional: track simple history stamps if the objects exist (no behavior change)
    try {
      const now = Date.now()
      teams.blue.voiceChannelHistory = teams.blue.voiceChannelHistory || {}
      teams.orange.voiceChannelHistory = teams.orange.voiceChannelHistory || {}
      teams.blue.voiceChannelHistory[blueVoice.id] = now
      teams.orange.voiceChannelHistory[orangeVoice.id] = now
    } catch (_) { /* non-fatal bookkeeping */ }

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
