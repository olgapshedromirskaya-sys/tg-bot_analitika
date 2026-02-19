const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const DEFAULT_KPI = {
  revenue: 5000000,
  conversion: 3.5,
  ad_budget: 100000,
  daily_orders: 100,
};

function resolveDbPath(inputPath) {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  return path.join(process.cwd(), inputPath);
}

function initDatabase() {
  const dbPath = resolveDbPath(process.env.DB_PATH || "./data/bot.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('owner', 'manager', 'marketer', 'viewer')),
      name TEXT,
      added_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS kpi_settings (
      key TEXT PRIMARY KEY,
      value REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const seedKpiStmt = db.prepare(`
    INSERT INTO kpi_settings(key, value, updated_at)
    VALUES (@key, @value, datetime('now'))
    ON CONFLICT(key) DO NOTHING;
  `);

  for (const [key, value] of Object.entries(DEFAULT_KPI)) {
    seedKpiStmt.run({ key, value });
  }

  const upsertUserStmt = db.prepare(`
    INSERT INTO users(telegram_id, role, name, added_by)
    VALUES (@telegram_id, @role, @name, @added_by)
    ON CONFLICT(telegram_id) DO UPDATE SET
      role = excluded.role,
      name = excluded.name,
      added_by = excluded.added_by;
  `);

  const getUserStmt = db.prepare(`
    SELECT telegram_id, role, name, added_by, created_at
    FROM users
    WHERE telegram_id = ?;
  `);

  const removeUserStmt = db.prepare(`
    DELETE FROM users
    WHERE telegram_id = ?;
  `);

  const listUsersStmt = db.prepare(`
    SELECT telegram_id, role, name, added_by, created_at
    FROM users
    ORDER BY
      CASE role
        WHEN 'owner' THEN 4
        WHEN 'manager' THEN 3
        WHEN 'marketer' THEN 2
        ELSE 1
      END DESC,
      datetime(created_at) ASC;
  `);

  const getKpiStmt = db.prepare(`
    SELECT key, value
    FROM kpi_settings;
  `);

  const setKpiStmt = db.prepare(`
    INSERT INTO kpi_settings(key, value, updated_at)
    VALUES (@key, @value, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now');
  `);

  const saveAlertStmt = db.prepare(`
    INSERT INTO alert_history(telegram_id, code, message)
    VALUES (@telegram_id, @code, @message);
  `);

  return {
    close() {
      db.close();
    },

    ensureOwner(telegramId) {
      if (!telegramId) {
        return;
      }

      const existing = getUserStmt.get(String(telegramId));
      if (existing && existing.role === "owner") {
        return;
      }

      upsertUserStmt.run({
        telegram_id: String(telegramId),
        role: "owner",
        name: existing?.name || "Owner",
        added_by: "system",
      });
    },

    getUserByTelegramId(telegramId) {
      return getUserStmt.get(String(telegramId));
    },

    upsertUser({ telegramId, role, name, addedBy }) {
      upsertUserStmt.run({
        telegram_id: String(telegramId),
        role,
        name: name || null,
        added_by: addedBy ? String(addedBy) : null,
      });
    },

    removeUser(telegramId) {
      return removeUserStmt.run(String(telegramId)).changes > 0;
    },

    listUsers() {
      return listUsersStmt.all();
    },

    getKpiSettings() {
      const rows = getKpiStmt.all();
      const result = {};

      for (const row of rows) {
        result[row.key] = Number(row.value);
      }

      for (const [key, value] of Object.entries(DEFAULT_KPI)) {
        if (typeof result[key] !== "number") {
          result[key] = value;
        }
      }

      return result;
    },

    setKpiValue(key, value) {
      setKpiStmt.run({ key, value: Number(value) });
    },

    saveAlert({ telegramId, code, message }) {
      saveAlertStmt.run({
        telegram_id: String(telegramId),
        code,
        message,
      });
    },
  };
}

module.exports = {
  initDatabase,
  DEFAULT_KPI,
};
