const ROLE_LEVELS = {
  viewer: 1,
  marketer: 2,
  manager: 3,
  owner: 4,
};

const ROLE_LABELS = {
  owner: "владелец",
  manager: "менеджер",
  marketer: "маркетолог",
  viewer: "наблюдатель",
};

function normalizeRole(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROLE_LEVELS, normalized)
    ? normalized
    : null;
}

function hasAccess(userRole, requiredRole) {
  const normalizedUserRole = normalizeRole(userRole);
  const normalizedRequiredRole = normalizeRole(requiredRole);

  if (!normalizedUserRole || !normalizedRequiredRole) {
    return false;
  }

  return ROLE_LEVELS[normalizedUserRole] >= ROLE_LEVELS[normalizedRequiredRole];
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

module.exports = {
  ROLE_LEVELS,
  ROLE_LABELS,
  normalizeRole,
  hasAccess,
  roleLabel,
};
