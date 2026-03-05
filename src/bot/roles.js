const ROLE_LEVELS = {
  manager: 1,
  admin:   2,
  owner:   3,
  tester:  1, // тот же уровень доступа к аналитике что и manager,
               // но с особой логикой в commands.js
};

const ROLE_LABELS = {
  owner:   "руководитель",
  admin:   "администратор",
  manager: "менеджер",
  tester:  "тестировщик",
};

// Что каждая роль НЕ может делать:
// manager   — не видит финансы, не управляет пользователями
// admin     — не управляет пользователями
// owner     — всё
// tester    — видит всё включая финансы, но:
//             ❌ не может добавлять/удалять сотрудников (скрыто)
//             ❌ не может сохранять API-ключи (заблокировано)
//             ❌ не может менять KPI (заблокировано)

function normalizeRole(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  const aliases = { viewer: "manager", marketer: "manager" };
  const mapped = aliases[normalized] || normalized;
  return Object.prototype.hasOwnProperty.call(ROLE_LEVELS, mapped) ? mapped : null;
}

function hasAccess(userRole, requiredRole) {
  const u = normalizeRole(userRole);
  const r = normalizeRole(requiredRole);
  if (!u || !r) return false;
  return ROLE_LEVELS[u] >= ROLE_LEVELS[r];
}

// Может ли роль управлять пользователями (только owner)
function canManageUsers(userRole) {
  return normalizeRole(userRole) === "owner";
}

// Может ли роль видеть финансы (admin, owner и tester)
function canViewFinance(userRole) {
  const r = normalizeRole(userRole);
  return r === "admin" || r === "owner" || r === "tester";
}

// Может ли роль сохранять API-ключи (только admin и owner, не tester)
function canSaveApiKeys(userRole) {
  const r = normalizeRole(userRole);
  return r === "admin" || r === "owner";
}

function roleLabel(role) {
  return ROLE_LABELS[normalizeRole(role) || role] || role;
}

module.exports = {
  ROLE_LEVELS,
  ROLE_LABELS,
  normalizeRole,
  hasAccess,
  canManageUsers,
  canViewFinance,
  canSaveApiKeys,
  roleLabel,
};
