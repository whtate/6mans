// utils/isQueueAdmin.js
// Lightweight privilege check that works across discord.js v11–v14.
// - Admin by Discord permission (ADMINISTRATOR or MANAGE_GUILD)
// - OR by role id in env ADMIN_ROLE_ID
// - OR by explicit allowlist in env ADMIN_USER_IDS (comma-separated)

function has(member, permName) {
  try {
    // v12/v13/v14
    if (member.permissions && typeof member.permissions.has === 'function') {
      return member.permissions.has(permName);
    }
    // v11
    if (typeof member.hasPermission === 'function') {
      return member.hasPermission(permName);
    }
  } catch (_) {}
  return false;
}

function hasRole(member, roleId) {
  if (!roleId || !member || !member.roles) return false;
  try {
    // v13+
    if (member.roles.cache && typeof member.roles.cache.has === 'function') {
      return member.roles.cache.has(roleId);
    }
    // v11/v12
    if (typeof member.roles.has === 'function') {
      return member.roles.has(roleId);
    }
  } catch (_) {}
  return false;
}

module.exports = function isQueueAdmin(member) {
  if (!member) return false;

  const byPerm =
    has(member, 'ADMINISTRATOR') ||
    has(member, 'MANAGE_GUILD') ||
    has(member, 'ManageGuild') ||
    has(member, 'Administrator');

  const byRole = process.env.ADMIN_ROLE_ID
    ? hasRole(member, process.env.ADMIN_ROLE_ID)
    : false;

  const allowList = (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const byAllow = allowList.includes(member.id);

  return Boolean(byPerm || byRole || byAllow);
};
