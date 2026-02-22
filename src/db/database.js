const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const DEFAULT_KPI = {
  ozon_revenue: 5000000,
  ozon_conversion: 3.5,
  ozon_ad_budget: 100000,
  ozon_daily_orders: 100,
  wb_revenue: 5000000,
  wb_conversion: 3.5,
  wb_ad_budget: 100000,
  wb_daily_orders: 100,
  // Старые ключи оставляем для обратной совместимости
  revenue: 5000000,
  conversion: 3.5,
  ad_budget: 100000,
  daily_orders: 100,
  // Финансы — раздельно по платформам
  ozon_commission:        15,
  ozon_min_profitability: 10,
  wb_commission:          15,
  wb_min_profitability:   10,
  // Себестоимость — общая для обеих площадок
  cost_percent: 40,
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_credentials (
      platform   TEXT PRIMARY KEY,
      api_key    TEXT NOT NULL,
      client_id  TEXT DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Себестоимость по артикулам — ОБЩАЯ для обеих площадок
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_costs (
      sku        TEXT PRIMARY KEY,
      name       TEXT,
      cost       REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Комиссии по категориям — РАЗДЕЛЬНЫЕ (platform = 'ozon' | 'wb')
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_commissions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      platform   TEXT NOT NULL,
      category   TEXT NOT NULL,
      rate       REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, category)
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
    WHERE telegram_id = ?
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
      datetime(created_at) ASC
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
      updated_at = excluded.updated_at;
  `);

  const saveAlertStmt = db.prepare(`
    INSERT INTO alert_history(telegram_id, code, message)
    VALUES (@telegram_id, @code, @message);
  `);

  const getCredentialsStmt = db.prepare(`
    SELECT platform, api_key, client_id, updated_at
    FROM api_credentials
    WHERE platform = ?
  `);

  const saveCredentialsStmt = db.prepare(`
    INSERT INTO api_credentials (platform, api_key, client_id)
    VALUES (@platform, @apiKey, @clientId)
    ON CONFLICT(platform) DO UPDATE SET
      api_key    = excluded.api_key,
      client_id  = excluded.client_id,
      updated_at = datetime('now')
  `);

  return {
    close() {
      db.close();
    },

    ensureOwner(telegramId) {
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

    // KPI платформы — финансы раздельные, себестоимость общая
    getKpiByPlatform(platform) {
      const all = this.getKpiSettings();
      return {
        revenue:           all[`${platform}_revenue`]           ?? all.revenue,
        conversion:        all[`${platform}_conversion`]        ?? all.conversion,
        ad_budget:         all[`${platform}_ad_budget`]         ?? all.ad_budget,
        daily_orders:      all[`${platform}_daily_orders`]      ?? all.daily_orders,
        supply_days:       all.supply_days                      ?? 14,
        // Своя для каждой платформы
        commission:        all[`${platform}_commission`]        ?? 15,
        min_profitability: all[`${platform}_min_profitability`] ?? 10,
        // Общая
        cost_percent:      all.cost_percent                     ?? 40,
      };
    },

    setKpiValue(key, value) {
      setKpiStmt.run({ key, value: Number(value) });
    },

    setKpiForPlatform(platform, { revenue, conversion, ad_budget, daily_orders }) {
      const fields = { revenue, conversion, ad_budget, daily_orders };
      for (const [field, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null && value !== "") {
          setKpiStmt.run({ key: `${platform}_${field}`, value: Number(value) });
        }
      }
    },

    // commission и min_profitability — с префиксом платформы (раздельные)
    // cost_percent — без префикса (общая)
    setFinanceForPlatform(platform, { commission, min_profitability, cost_percent }) {
      if (commission        != null && commission        !== "") {
        setKpiStmt.run({ key: `${platform}_commission`,        value: Number(commission) });
      }
      if (min_profitability != null && min_profitability !== "") {
        setKpiStmt.run({ key: `${platform}_min_profitability`, value: Number(min_profitability) });
      }
      if (cost_percent      != null && cost_percent      !== "") {
        setKpiStmt.run({ key: 'cost_percent',                  value: Number(cost_percent) });
      }
    },

    saveAlert({ telegramId, code, message }) {
      saveAlertStmt.run({
        telegram_id: String(telegramId),
        code,
        message,
      });
    },

    getApiCredentials(platform) {
      return getCredentialsStmt.get(platform);
    },

    saveApiCredentials({ platform, apiKey, clientId = "" }) {
      saveCredentialsStmt.run({ platform, apiKey, clientId });
    },

    hasCredentials(platform) {
      const creds = getCredentialsStmt.get(platform);
      return !!(creds && creds.api_key);
    },

    deleteApiCredentials(platform) {
      db.prepare('DELETE FROM api_credentials WHERE platform = ?').run(platform);
    },

    // ── Себестоимость (общая таблица) ────────────────────────────────
    upsertProductCost({ sku, name, cost }) {
      db.prepare(`
        INSERT INTO product_costs (sku, name, cost, updated_at)
        VALUES (@sku, @name, @cost, datetime('now'))
        ON CONFLICT(sku) DO UPDATE SET
          name = excluded.name,
          cost = excluded.cost,
          updated_at = excluded.updated_at
      `).run({ sku: String(sku), name: name || '', cost: Number(cost) });
    },

    getProductCosts() {
      return db.prepare('SELECT sku, name, cost FROM product_costs ORDER BY name').all();
    },

    getProductCostBySku(sku) {
      const row = db.prepare('SELECT cost FROM product_costs WHERE sku = ?').get(String(sku));
      return row ? Number(row.cost) : null;
    },

    deleteAllProductCosts() {
      db.prepare('DELETE FROM product_costs').run();
    },

    // ── Комиссии (раздельные по платформам) ─────────────────────────
    upsertCommission({ platform, category, rate }) {
      db.prepare(`
        INSERT INTO marketplace_commissions (platform, category, rate, updated_at)
        VALUES (@platform, @category, @rate, datetime('now'))
        ON CONFLICT(platform, category) DO UPDATE SET
          rate = excluded.rate,
          updated_at = excluded.updated_at
      `).run({ platform, category: String(category), rate: Number(rate) });
    },

    getCommissions(platform) {
      return db.prepare('SELECT category, rate FROM marketplace_commissions WHERE platform = ? ORDER BY category').all(platform);
    },

    deleteCommissions(platform) {
      db.prepare('DELETE FROM marketplace_commissions WHERE platform = ?').run(platform);
    },

    getAvgCommission(platform) {
      const row = db.prepare('SELECT AVG(rate) as avg FROM marketplace_commissions WHERE platform = ?').get(platform);
      return row && row.avg ? Number(row.avg) : null;
    },
  };
}

module.exports = {
  initDatabase,
  DEFAULT_KPI,
};
