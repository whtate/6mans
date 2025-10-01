// actions/getQueueStatus.js
// Enhancements:
// - Anyone can call !status (no membership gate here)
// - Shows “currently picking” if a captain draft is active
// - Shows “expired/disbanded” state if present

// NEW: allow REQUIRED_PLAYERS override via env (defaults to 6)
const REQUIRED_PLAYERS =
  Number.isFinite(parseInt(process.env.REQUIRED_PLAYERS, 10))
    ? parseInt(process.env.REQUIRED_PLAYERS, 10)
    : 6

function mentionsFromIndexed(indexed) {
  if (!indexed) return '—';
  const ids = Object.keys(indexed).filter(Boolean);
  if (!ids.length) return '—';
  return ids.map(id => `<@${id}>`).join(', ');
}

module.exports = (eventObj, queue) => {
  const channel = eventObj.channel;

  if (!queue) {
    return channel.send(
      'No active queue. Type `!q` to start one.'
    );
  }

  const {
    players = [],
    playerIdsIndexed,
    lobby = {},
    votingInProgress,
    creatingTeamsInProgress,
    readyToJoin,
    status, // optional: 'open' | 'drafting' | 'in-progress' | 'expired'
    draft,  // optional draft state (see createCaptainTeams / managePlayerQueues)
    expiresAt
  } = queue;

  // Use env-driven required players instead of a hard-coded 6
  const remainingPlayersRequired = Math.max(0, REQUIRED_PLAYERS - players.length);

  const fields = [
    {
      name: 'Players in the queue',
      value: mentionsFromIndexed(playerIdsIndexed)
    },
    { name: 'Voting', value: String(Boolean(votingInProgress)), inline: true },
    {
      name: 'Creating Teams',
      value: String(Boolean(creatingTeamsInProgress)),
      inline: true
    },
    { name: 'Lobby Ready', value: String(Boolean(readyToJoin)), inline: true }
  ];

  // Show currently picking captain if draft is active
  if (draft && draft.mode === 'captains') {
    // Your earlier createCaptainTeams status used: draft.currentPicker + draft.captains.blue/orange
    // Your queue template also uses: draft.currentCaptainId (single user id)
    let pickerId = null;

    if (draft.currentPicker && draft.captains) {
      pickerId = draft.currentPicker === 'blue' ? draft.captains?.blue : draft.captains?.orange;
    }

    // Fallback to template-style currentCaptainId if present
    if (!pickerId && draft.currentCaptainId) {
      pickerId = draft.currentCaptainId;
    }

    if (pickerId) {
      fields.push({
        name: 'Currently picking',
        value: `<@${pickerId}>`
      });
    }
  }

  // Expired banner
  let description = `${remainingPlayersRequired} players needed`;
  if (status === 'expired') {
    const when =
      expiresAt
        ? `<t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R>`
        : 'recently';
    description = `🛑 Queue expired ${when}. Start a new one with \`!q\`.`;
  }

  return channel.send({
    embed: {
      color: status === 'expired' ? 15158332 : 2201331,
      title: `Lobby ${lobby?.name || '—'} — Status`,
      description,
      fields
    }
  });
};
