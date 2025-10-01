// utils/commands.js

// Primary (simple) commands
exports.commandToString = {
  queue: '!q',
  leave: '!leave',
  status: '!status',
  votestatus: '!votestatus',
  r: '!r',
  c: '!c',
  help: '!help',
  kick: '!kick',

  stats: '!stats',
  leaderboard: '!lb',        // shorter primary
  report: '!report',

  // HISTORY COMMANDS
  // Player history (stays !history)
  playerhistory: '!history',

  // Lobby history (no hyphen). Auto selects most recent lobby if no arg.
  lobbyhistory: '!lobbyhistory',

  // Last match (shorter)
  lastmatch: '!last',

  // Remake vote
  remake: '!remake',

  // NEW: Admin prune command (delete users not in the server anymore)
  pruneusers: '!prune_users',
}

// All strings that the bot should accept (aliases)
exports.validCommandCheck = {
  // queue & flow
  '!q': true,
  '!queue': true,
  '!leave': true,
  '!status': true,
  '!votestatus': true,
  '!r': true,
  '!c': true,
  '!help': true,
  '!kick': true,

  // stats & boards
  '!stats': true,
  '!lb': true,
  '!leaderboard': true,         // alias

  // reporting
  '!report': true,

  // history family
  '!history': true,             // player history
  '!lobbyhistory': true,        // lobby history (new primary)
  '!lh': true,                  // alias
  '!lobby': true,               // alias
  '!lobby-history': true,       // legacy hyphen still works

  // last match
  '!last': true,
  '!lastmatch': true,           // alias
  '!last-match': true,          // legacy hyphen

  // remake vote
  '!remake': true,

  // NEW: admin prune command aliases
  '!prune_users': true,         // primary
  '!pruneusers': true,          // alias
  '!prune': true,               // short alias
}
