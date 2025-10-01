// actions/createCaptainTeams.js
// Enhancements:
// - Writes public draft state onto queue.draft so !status can show the current picker
// - Leaves your picking logic intact conceptually (first pick 1, second pick 2, last auto)
// NOTE: This is a self-contained version that relies only on basic queue shape.

const { randomInt } = require('crypto');

function rand(n) {
  // randomInt is inclusive of min, exclusive of max
  return typeof randomInt === 'function'
    ? randomInt(n)
    : Math.floor(Math.random() * n);
}

function playersToMentions(players) {
  return players.map((p, i) => `${i}. <@${p.id}>`).join('\n');
}

module.exports = async (eventObj, queue) => {
  const channel = eventObj.channel;

  // Normalize structures
  queue.players = (queue.players || []).filter(Boolean);
  queue.teams = queue.teams || { blue: { players: [] }, orange: { players: [] } };
  const { players, teams } = queue;

  // Init draft state
  queue.draft = {
    mode: 'captains',
    currentPicker: null, // 'blue' or 'orange'
    captains: { blue: null, orange: null },
    unpicked: players.map(p => p.id),
    // NEW: mirror a single-user id for who is picking (compatible with managePlayerQueues template)
    currentCaptainId: null,
    // NEW: optional pick log
    picks: []
  };
  // NEW: set high-level queue status for visibility (does not alter flow)
  queue.status = 'drafting';

  // Pick captains randomly for simplicity (preserves behavior you described)
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

  const firstPick = rand(2) === 0 ? 'blue' : 'orange';
  const secondPick = firstPick === 'blue' ? 'orange' : 'blue';
  queue.draft.currentPicker = firstPick;
  queue.draft.currentCaptainId = teams[firstPick].captain.id; // NEW: single-id mirror
  queue.draft.unpicked = players.map(p => p.id);

  // FIRST PICK: choose ONE by index via reaction-style prompt substitute (DM -> channel prompt)
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
      // NEW: log pick + refresh mirrors
      queue.draft.picks.push({ by: teams[firstPick].captain.id, picked: pick.id });
      queue.draft.unpicked = players.map(p => p.id);
      firstCollector.stop('picked');
      stepDone = true;

      // SECOND PICK (2 players)
      queue.draft.currentPicker = secondPick;
      queue.draft.currentCaptainId = teams[secondPick].captain.id; // NEW: switch single-id mirror
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
            // NEW: log both picks
            if (picked[0]) queue.draft.picks.push({ by: teams[secondPick].captain.id, picked: picked[0].id });
            if (picked[1]) queue.draft.picks.push({ by: teams[secondPick].captain.id, picked: picked[1].id });
            queue.draft.unpicked = players.map(p => p.id);

            // Last player auto to firstPick team
            if (players.length === 1) {
              const last = players.pop();
              teams[firstPick].players.push(last);
              // NEW: log last auto assignment as a synthetic pick by the firstPick captain
              if (last) queue.draft.picks.push({ by: teams[firstPick].captain.id, picked: last.id, auto: true });
              queue.draft.unpicked = [];
              queue.draft.currentPicker = null;
              queue.draft.currentCaptainId = null; // NEW
              queue.status = 'creating-teams'; // NEW: progress hint for status
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
          queue.draft.currentCaptainId = null; // NEW
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
      queue.draft.currentCaptainId = null; // NEW
      await channel.send('First pick timed out.');
    }
  });
};
