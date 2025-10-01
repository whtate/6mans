// actions/enterQueue.js
// Enhancements:
// - Replies with user's position in the queue (e.g., “you’re #4”)
// - Gentle no-op if already queued

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel;
  const playerId = eventObj.author.id;

  // Standard queue shape we expect:
  // queue.players: [{ id, ... }]
  // queue.playerIdsIndexed: { [discordId]: true }
  queue.players = Array.isArray(queue.players) ? queue.players : [];
  queue.playerIdsIndexed = queue.playerIdsIndexed || Object.create(null);

  if (queue.playerIdsIndexed[playerId]) {
    const position =
      queue.players.findIndex(p => p && p.id === playerId) + 1 || 1;
    return channel.send(
      `You’re already in the queue <@${playerId}> — **#${position}** (${queue.players.length}/6).`
    );
  }

  // Add player
  const player = { id: playerId };
  queue.players.push(player);
  queue.playerIdsIndexed[playerId] = true;

  // Position (1-based)
  const position = queue.players.length;

  // Notify
  return channel.send(
    `Queued ✅ <@${playerId}> — you’re **#${position}** (${position}/6).`
  );
};
