// actions/createCaptainTeams.js
// Enhancements:
// - Writes public draft state onto queue.draft so !status can show the current picker
// - Leaves your picking logic intact (first pick 1, second pick 2, last auto)
// - NEW: DMs both captains a "scouting card" listing all draft-eligible players
//        with MMR, lifetime W/L, and this month’s ΔMMR for smarter picks.

const { randomInt } = require('crypto');
const { getStats, upsertPlayer } = require('../db');

function rand(n) {
  // randomInt is inclusive of min, exclusive of max
  return typeof randomInt === 'function'
    ? randomInt(n)
    : Math.floor(Math.random() * n);
}

function playersToMentions(players) {
  return players.map((p, i) => `${i}. <@${p.id}>`).join('\n');
}

function fmtDelta(n) {
  const v = Number(n) || 0;
  return `${v >= 0 ? '+' : ''}${v}`;
}

async function buildScoutingLines(guildId, candidates, client) {
  // candidates: [{id, username?}, ...]
  const lines = [];
  for (const [i, p] of candidates.entries()) {
    const id = p.id;
    const username = p.username || null;
    // Make sure we have a username on file (prevents numeric IDs on boards later)
    try {
      const userObj = client?.users?.get?.(id) || client?.users?.cache?.get?.(id);
      const name = userObj?.username || username || String(id);
      await upsertPlayer({ guildId, userId: id, username: name });
    } catch (_) {}

    let mmr = 1000, wins = 0, losses = 0, monthDelta = 0;
    try {
      const stats = await getStats({ guildId, userId: id });
      if (stats?.life) {
        mmr = stats.life.mmr ?? 1000;
        wins = stats.life.wins ?? 0;
        losses = stats.life.losses ?? 0;
      }
      if (stats?.month) {
        monthDelta = stats.month.mmr_delta ?? 0;
      }
    } catch (e) {
      // if db query fails for some reason, fall back gracefully
    }

    const line =
      `**${i}.** <@${id}> — ` +
      `MMR **${mmr}** — ` +
      `W/L **${wins}/${losses}** — ` +
      `ΔMMR (mo) **${fmtDelta(monthDelta)}**`;
    lines.push(line);
  }
  return lines;
}

async function dmScoutingCard(captainUser, guildId, candidates, client, headerNote = '') {
  try {
    const lines = await buildScoutingLines(guildId, candidates, client);
    const msg =
      (headerNote ? `${headerNote}\n\n` : '') +
      `**Draft-Eligible Players**\n` +
      lines.join('\n');
    const dm = await captainUser.createDM();
    await dm.send(msg);
  } catch (e) {
    // If DMs are closed, just skip; channel flow still works.
    console.error('Failed to DM scouting card:', e?.message || e);
  }
}

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel;
  const client = require('../index'); // to resolve users for usernames in DMs
  const guildId = eventObj.guild?.id;

  // Normalize structures
  queue.players = (queue.players || []).filter(Boolean);
  queue.teams = queue.teams || { blue: { players: [] }, orange: { players: [] } };
  const { players, teams } = queue;

  // Init draft state
  queue.draft = {
    mode: 'captains',
    currentPicker: null, // 'blue' or 'orange'
    captains: { blue: null, orange: null },
    unpicked: players.map(p => p.id)
  };

  // Pick captains randomly
  const blueIndex = rand(players.length);
  const blueCaptain = players.splice(blueIndex, 1)[0];
  teams.blue.captain = blueCaptain;
  teams.blue.players.push(blueCaptain);
  queue.draft.captains.blue = blueCaptain.id;

  const orangeIndex = rand(players.length);
  const orangeCaptain = players.splice(orangeIndex, 1)[0];
  teams.orange.captain = orangeCaptain;
  teams.orange.players.push(orangeCaptain);
  queue.draft.captains.orange = orangeCaptain.id;

  // Announce captains publicly
  await channel.send({
    embed: {
      color: 2201331,
      title: `Captain structure`,
      description:
        'The vote resulted in captains. The following are your captains:',
      fields: [
        { name: 'Captain Blue', value: `<@${teams.blue.captain.id}>` },
        { name: 'Captain Orange', value: `<@${teams.orange.captain.id}>` }
      ]
    }
  });

  // Choose pick order (random)
  const firstPick = rand(2) === 0 ? 'blue' : 'orange';
  const secondPick = firstPick === 'blue' ? 'orange' : 'blue';
  queue.draft.currentPicker = firstPick;
  queue.draft.unpicked = players.map(p => p.id);

  // NEW: DM both captains a scouting card with MMR & records for all draft-eligible players
  try {
    const blueUser   = client.users.get?.(teams.blue.captain.id)   || client.users.cache?.get?.(teams.blue.captain.id);
    const orangeUser = client.users.get?.(teams.orange.captain.id) || client.users.cache?.get?.(teams.orange.captain.id);
    if (blueUser) {
      await dmScoutingCard(
        blueUser,
        guildId,
        players,
        client,
        `You are **Captain ${firstPick === 'blue' ? 'FIRST' : 'SECOND'} pick**.`
      );
    }
    if (orangeUser) {
      await dmScoutingCard(
        orangeUser,
        guildId,
        players,
        client,
        `You are **Captain ${firstPick === 'orange' ? 'FIRST' : 'SECOND'} pick**.`
      );
    }
  } catch (e) {
    console.error('Error sending scouting DMs:', e?.message || e);
  }

  // FIRST PICK in channel (1 player)
  const firstMsg = await channel.send(
    `First pick: <@${teams[firstPick].captain.id}> — reply with the **index** of ONE player:\n` +
      playersToMentions(players)
  );

  const firstCollector = channel.createMessageCollector(
    (m) => m.author.id === teams[firstPick].captain.id,
    { time: 60_000 }
  );

  let stepDone = false;

  firstCollector.on('collect', async (m) => {
    const idx = parseInt(m.content, 10);
    if (Number.isInteger(idx) && players[idx]) {
      const pick = players.splice(idx, 1)[0];
      teams[firstPick].players.push(pick);
      queue.draft.unpicked = players.map(p => p.id);
      firstCollector.stop('picked');
      stepDone = true;

      // After first pick, re-send scouting updates to the second captain (optional)
      try {
        const secondCaptainId = teams[secondPick].captain.id;
        const secondUser = client.users.get?.(secondCaptainId) || client.users.cache?.get?.(secondCaptainId);
        if (secondUser) {
          await dmScoutingCard(
            secondUser,
            guildId,
            players, // updated list
            client,
            `Updated candidates after first pick:`
          );
        }
      } catch (_) {}

      // SECOND PICK (2 players)
      queue.draft.currentPicker = secondPick;
      await channel.send(
        `Second pick x2: <@${teams[secondPick].captain.id}> — reply with **two indices separated by space** from:\n` +
          playersToMentions(players)
      );

      const secondCollector = channel.createMessageCollector(
        (mm) => mm.author.id === teams[secondPick].captain.id,
        { time: 60_000 }
      );

      secondCollector.on('collect', async (mm) => {
        const parts = mm.content.split(/\s+/).map((s) => parseInt(s, 10));
        if (parts.length >= 2 && parts.every(Number.isInteger)) {
          // sort descending to splice correctly
          const sorted = [...new Set(parts)].sort((a, b) => b - a);
          const picked = [];
          for (const idxx of sorted) {
            if (players[idxx]) {
              picked.push(players.splice(idxx, 1)[0]);
            }
          }
          if (picked.length >= 2) {
            teams[secondPick].players.push(picked[0], picked[1]);
            queue.draft.unpicked = players.map(p => p.id);

            // Last player auto to firstPick team
            if (players.length === 1) {
              teams[firstPick].players.push(players.pop());
              queue.draft.unpicked = [];
              queue.draft.currentPicker = null;
            }

            secondCollector.stop('done');

            await channel.send({
              embed: {
                color: 3066993,
                title: 'Teams are ready!',
                fields: [
                  {
                    name: 'Blue',
                    value: teams.blue.players.map(p => `<@${p.id}>`).join(', ')
                  },
                  {
                    name: 'Orange',
                    value: teams.orange.players.map(p => `<@${p.id}>`).join(', ')
                  }
                ]
              }
            });
          } else {
            await channel.send('Please provide **two** valid indices.');
          }
        } else {
          await channel.send('Format: `i j` (two numbers).');
        }
      });

      secondCollector.on('end', async (_, reason) => {
        if (reason !== 'done') {
          queue.draft.currentPicker = null;
          await channel.send('Draft timed out.');
        }
      });
    } else {
      await channel.send('Please provide a valid index from the list.');
    }
  });

  firstCollector.on('end', async (_, reason) => {
    if (!stepDone && reason !== 'picked') {
      queue.draft.currentPicker = null;
      await channel.send('First pick timed out.');
    }
  });
};
