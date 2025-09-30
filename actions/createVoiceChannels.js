// actions/createVoiceChannels.js
module.exports = async (eventObj, queue) => {
  const { lobby, teams } = queue
  const channel = eventObj.channel
  const guild = eventObj.guild

  if (!guild || !guild.available) {
    return channel.send('I do not have access to this guild right now.')
  }

  // Find the category to put voice channels under
  const parentChannel = guild.channels.find(
    ch => ch.type === 'category' && ch.name === process.env.categoryName
  )
  if (!parentChannel) {
    return channel.send(
      `Category **${process.env.categoryName}** not found. Create it first (exact name), then try again.`
    )
  }

  // @everyone role for default denies
  const everyoneRole = guild.roles.find(r => r.name === '@everyone')
  if (!everyoneRole) {
    return channel.send('Could not find @everyone role. Check the bot permissions/roles.')
  }

  // Build v11-compatible permission overwrites
  const blueOverwrites = [
    {
      id: everyoneRole.id,
      type: 'role',
      deny: ['CONNECT', 'SPEAK', 'CREATE_INSTANT_INVITE'],
    },
    ...teams.blue.players
      .filter(p => p && p.id)
      .map(p => ({
        id: p.id,
        type: 'member',
        allow: ['CONNECT', 'SPEAK'],
      })),
  ]

  const orangeOverwrites = [
    {
      id: everyoneRole.id,
      type: 'role',
      deny: ['CONNECT', 'SPEAK', 'CREATE_INSTANT_INVITE'],
    },
    ...teams.orange.players
      .filter(p => p && p.id)
      .map(p => ({
        id: p.id,
        type: 'member',
        allow: ['CONNECT', 'SPEAK'],
      })),
  ]

  // Create Blue voice channel
  const blueVoiceChannel = await guild.createChannel(`${lobby.name}-blue`, 'voice', {
    parent: parentChannel.id,
    userLimit: 3,
    permissionOverwrites: blueOverwrites,
  })

  // Create Orange voice channel
  const orangeVoiceChannel = await guild.createChannel(`${lobby.name}-orange`, 'voice', {
    parent: parentChannel.id,
    userLimit: 3,
    permissionOverwrites: orangeOverwrites,
  })

  // Save IDs back to queue
  teams.blue.voiceChannelID = blueVoiceChannel.id
  teams.orange.voiceChannelID = orangeVoiceChannel.id

  // Optional: confirm
  channel.send(
    `Voice channels created:\n• <#${blueVoiceChannel.id}>\n• <#${orangeVoiceChannel.id}>`
  )
}
