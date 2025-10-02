// scripts/addSeries.js
// Usage:
//   node scripts/addSeries.js \
//     --guild <GUILD_ID> \
//     --winner A|B \
//     --teamA 111,222,333 \
//     --teamB 444,555,666 \
//     --reporter <REPORTER_USER_ID> \
//     [--lobby swb1] [--region "US-East"] [--series 5]
//
// Example:
//   node scripts/addSeries.js --guild 123 --winner B \
//     --teamA 1,2,3 --teamB 4,5,6 --reporter 4 --lobby swb3 --region "US-East" --series 5

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { init, recordResult } = require('../db')

function die(msg) { console.error(msg); process.exit(1) }

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const k = args[i]
    const v = args[i + 1]
    if (k.startsWith('--')) {
      out[k.replace(/^--/, '')] = v
      i++
    }
  }
  return out
}

function splitIds(val, name) {
  if (!val) die(`Missing --${name} (comma-separated discord user IDs)`)
  return val.split(',').map(s => s.trim()).filter(Boolean)
}

(async function main() {
  const argv = parseArgs()

  const guildId = argv.guild || argv.g
  const winner = (argv.winner || '').toUpperCase()
  const reporterUserId = argv.reporter
  const lobbyName = argv.lobby || null
  const lobbyRegion = argv.region || null
  const lobbySeries = argv.series ? parseInt(argv.series, 10) : null
  const teamAIds = splitIds(argv.teamA, 'teamA')
  const teamBIds = splitIds(argv.teamB, 'teamB')

  if (!guildId) die('Missing --guild <GUILD_ID>')
  if (!['A', 'B'].includes(winner)) die('Missing/invalid --winner A|B')
  if (!reporterUserId) die('Missing --reporter <USER_ID>')

  await init()

  try {
    console.log('➕ Recording series…')
    const res = await recordResult({
      guildId,
      teamAIds,
      teamBIds,
      winner,
      reporterUserId,
      lobbyName,
      lobbyRegion,
      lobbySeries
    })
    console.log('✅ Match recorded:')
    console.log(JSON.stringify(res, null, 2))
    console.log('Done.')
    process.exit(0)
  } catch (e) {
    console.error('❌ Failed:', e && e.message ? e.message : e)
    process.exit(1)
  }
})()
