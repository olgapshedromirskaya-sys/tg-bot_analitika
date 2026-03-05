const express = require("express");
const path = require("node:path");
const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const cache = {
  wb:   { data: null, updatedAt: 0 },
  ozon: { data: null, updatedAt: 0 },
};
const CACHE_TTL_MS = 15 * 60 * 1000;

function calcFinance(revenue, adSpend, kpi) {
  if (!revenue) return { cost: 0, commission: 0, adSpend: 0, netProfit: 0, margin: 0, isHealthy: false };
  const costPct    = Number(kpi.cost_percent      || 40);
  const commRate   = Number(kpi.commission        || 15);
  const minProfit  = Number(kpi.min_profitability || 10);
  const cost       = revenue * (costPct  / 100);
  const comm       = revenue * (commRate / 100);
  const ad         = adSpend || 0;
  const netProfit  = revenue - cost - comm - ad;
  const margin     = (netProfit / revenue) * 100;
  return { cost, commission: comm, adSpend: ad, netProfit, margin, isHealthy: margin >= minProfit };
}

// ── Извлекаем telegram_id из Telegram WebApp initData ───────────────
// initData передаётся в заголовке X-Telegram-Init-Data (устанавливается в webapp JS)
function extractTelegramId(req) {
  // 1. Из заголовка напрямую (если webapp передаёт)
  const directId = req.headers["x-telegram-user-id"];
  if (directId) return String(directId);

  // 2. Из initData (URL-encoded строка от Telegram.WebApp.initData)
  const initData = req.headers["x-telegram-init-data"];
  if (initData) {
    try {
      const params = new URLSearchParams(initData);
      const userStr = params.get("user");
      if (userStr) {
        const user = JSON.parse(decodeURIComponent(userStr));
        if (user?.id) return String(user.id);
      }
    } catch (e) {}
  }

  return null;
}

function startWebAppServer({ db }) {
  const app = express();

  app.use(express.json());
  app.use("/assets", express.static(path.join(__dirname, "../../webapp/assets")));

  // ── GET /api/me — роль текущего пользователя ─────────────────────
  app.get("/api/me", (req, res) => {
    try {
      const telegramId = extractTelegramId(req);
      if (!telegramId) return res.json({ role: "guest", telegramId: null });
      const user = db.getUserByTelegramId(telegramId);
      if (!user) return res.json({ role: "guest", telegramId });
      res.json({ role: user.role, telegramId, name: user.name || null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/credentials/status", (req, res) => {
    res.json({ ozon: db.hasCredentials("ozon"), wb: db.hasCredentials("wb") });
  });

  // ── POST /api/credentials — тестировщик заблокирован ─────────────
  app.post("/api/credentials", (req, res) => {
    try {
      const { platform, apiKey, clientId } = req.body;
      if (!platform || !apiKey) return res.status(400).json({ error: "Не указана платформа или ключ" });

      // Проверка роли — тестировщик не может сохранять API-ключи
      const telegramId = extractTelegramId(req);
      if (telegramId) {
        const user = db.getUserByTelegramId(telegramId);
        if (user?.role === "tester") {
          return res.status(403).json({ error: "Тестовый режим — сохранение API-ключей недоступно" });
        }
      }

      db.saveApiCredentials({ platform, apiKey, clientId: clientId || "" });
      if (platform === "ozon") {
        process.env.OZON_API_KEY   = apiKey;
        process.env.OZON_CLIENT_ID = clientId || "";
      } else if (platform === "wb") {
        process.env.WB_API_KEY   = apiKey;
        process.env.WB_API_TOKEN = apiKey;
      }
      cache[platform] = { data: null, updatedAt: 0 };
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/kpi", (req, res) => {
    try { res.json(db.getKpiSettings()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/kpi", (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key || value === undefined) return res.status(400).json({ error: "Не указан ключ или значение" });
      db.setKpiValue(key, Number(value));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/kpi/:platform", (req, res) => {
    try {
      const { platform } = req.params;
      if (!["ozon", "wb"].includes(platform)) return res.status(400).json({ error: "Неизвестная платформа" });
      res.json(db.getKpiByPlatform(platform));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/kpi/:platform", (req, res) => {
    try {
      const { platform } = req.params;
      if (!["ozon", "wb"].includes(platform)) return res.status(400).json({ error: "Неизвестная платформа" });
      const { revenue, conversion, ad_budget, daily_orders } = req.body;
      db.setKpiForPlatform(platform, { revenue, conversion, ad_budget, daily_orders });
      cache[platform] = { data: null, updatedAt: 0 };
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/finance/:platform", (req, res) => {
    try {
      const { platform } = req.params;
      if (!["ozon", "wb"].includes(platform)) return res.status(400).json({ error: "Неизвестная платформа" });
      const { commission, min_profitability, cost_percent } = req.body;
      db.setFinanceForPlatform(platform, { commission, min_profitability, cost_percent });
      cache[platform] = { data: null, updatedAt: 0 };
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/costs/upload", upload.single("file"), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Файл не загружен" });
      const text  = req.file.buffer.toString("utf8").replace(/\r/g, "");
      const lines = text.split("\n").filter(l => l.trim());
      const sep   = lines[0].includes(";") ? ";" : ",";
      const startIdx = isNaN(lines[0].split(sep)[0].trim()) ? 1 : 0;
      db.deleteAllProductCosts();
      let imported = 0;
      const errors = [];
      for (let i = startIdx; i < lines.length; i++) {
        const parts = lines[i].split(sep).map(s => s.trim().replace(/^["']|["']$/g, ""));
        const sku     = parts[0];
        const name    = parts[1] || "";
        const rawCost = parts.length >= 3 ? parts[2] : parts[1];
        const cost    = parseFloat((rawCost || "0").replace(",", "."));
        if (!sku) continue;
        if (isNaN(cost)) { errors.push(`Строка ${i + 1}: неверная себестоимость`); continue; }
        db.upsertProductCost({ sku, name, cost });
        imported++;
      }
      res.json({ ok: true, imported, errors });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/costs", (req, res) => {
    try { res.json(db.getProductCosts()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/costs", (req, res) => {
    try { db.deleteAllProductCosts(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/commissions/wb/upload", upload.single("file"), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Файл не загружен" });
      const XLSX  = require("xlsx");
      const wb    = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows  = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      db.deleteCommissions("wb");
      let imported = 0;
      for (const row of rows) {
        const keys    = Object.keys(row);
        const catKey  = keys.find(k => /катег|наимен|предмет/i.test(k));
        const rateKey = keys.find(k => /комисс|ставка|%/i.test(k) && k !== catKey);
        if (!catKey || !rateKey) continue;
        const category = String(row[catKey]).trim();
        const rate     = parseFloat(String(row[rateKey]).replace(",", ".").replace("%", "").trim());
        if (!category || isNaN(rate) || rate <= 0) continue;
        db.upsertCommission({ platform: "wb", category, rate });
        imported++;
      }
      res.json({ ok: true, imported });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/commissions/ozon/fetch", async (req, res) => {
    try {
      const creds = db.getApiCredentials("ozon");
      if (!creds || !creds.api_key) return res.status(400).json({ error: "Сначала добавьте API-ключи Ozon" });
      const response = await fetch("https://api-seller.ozon.ru/v1/category/commission", {
        method: "POST",
        headers: { "Client-Id": creds.client_id || "", "Api-Key": creds.api_key, "Content-Type": "application/json" },
        body: JSON.stringify({ category_id: [], type: "fbo" }),
      });
      if (!response.ok) {
        const err = await response.text();
        return res.status(400).json({ error: `Ozon API: ${response.status} — ${err}` });
      }
      const data  = await response.json();
      const items = data.result || data.items || [];
      db.deleteCommissions("ozon");
      let imported = 0;
      for (const item of items) {
        const category = item.category_name || item.name || String(item.category_id || "");
        const rate     = item.sales_percent || item.percent || item.commission_percent || 0;
        if (!category || !rate) continue;
        db.upsertCommission({ platform: "ozon", category, rate: Number(rate) });
        imported++;
      }
      res.json({ ok: true, imported });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/commissions/:platform", (req, res) => {
    try {
      const { platform } = req.params;
      if (!["ozon", "wb"].includes(platform)) return res.status(400).json({ error: "Неизвестная платформа" });
      res.json(db.getCommissions(platform));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Данные WB ────────────────────────────────────────────────────
  app.get("/api/data/wb", async (req, res) => {
    try {
      const creds = db.getApiCredentials("wb");
      const now = Date.now();
      if (cache.wb.data && (now - cache.wb.updatedAt) < CACHE_TTL_MS) {
        console.log("[WB] Отдаю из кэша");
        return res.json(cache.wb.data);
      }
      if (creds) {
        process.env.WB_API_KEY   = creds.api_key;
        process.env.WB_API_TOKEN = creds.api_key;
      } else {
        process.env.WB_API_KEY   = "";
        process.env.WB_API_TOKEN = "";
      }
      delete require.cache[require.resolve("../api/wildberries")];
      const { getWildberriesMetrics } = require("../api/wildberries");
      const metrics = await getWildberriesMetrics();
      const kpi = typeof db.getKpiByPlatform === "function"
        ? db.getKpiByPlatform("wb") : db.getKpiSettings();
      const avgComm = db.getAvgCommission("wb");
      const finKpi  = { ...kpi, commission: avgComm ?? kpi.commission };
      const result = {
        today:          metrics.today          || null,
        month:          metrics.month          || null,
        stocks:         metrics.stocks         || [],
        warehouses:     metrics.warehouses     || [],
        atRiskProducts: metrics.atRiskProducts || [],
        redemption:     metrics.redemption     || null,
        kpi,
        finance: {
          today: calcFinance(metrics.today?.revenue || 0, metrics.today?.adSpend || 0, finKpi),
          month: calcFinance(metrics.month?.revenue || 0, metrics.month?.adSpend || 0, finKpi),
        },
        source:   metrics.source || "unknown",
        cachedAt: new Date().toISOString(),
      };
      if (metrics.source !== "error") {
        cache.wb = { data: result, updatedAt: now };
      }
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Данные Ozon ──────────────────────────────────────────────────
  app.get("/api/data/ozon", async (req, res) => {
    try {
      const creds = db.getApiCredentials("ozon");
      const now = Date.now();
      if (cache.ozon.data && (now - cache.ozon.updatedAt) < CACHE_TTL_MS) {
        console.log("[Ozon] Отдаю из кэша");
        return res.json(cache.ozon.data);
      }
      if (creds) {
        process.env.OZON_API_KEY   = creds.api_key;
        process.env.OZON_CLIENT_ID = creds.client_id || "";
      } else {
        process.env.OZON_API_KEY   = "";
        process.env.OZON_CLIENT_ID = "";
      }
      delete require.cache[require.resolve("../api/ozon")];
      const { getOzonMetrics } = require("../api/ozon");
      const metrics = await getOzonMetrics();
      const kpi = typeof db.getKpiByPlatform === "function"
        ? db.getKpiByPlatform("ozon") : db.getKpiSettings();
      const avgComm = db.getAvgCommission("ozon");
      const finKpi  = { ...kpi, commission: avgComm ?? kpi.commission };
      const result = {
        today:          metrics.today          || null,
        month:          metrics.month          || null,
        stocks:         metrics.stocks         || [],
        warehouses:     metrics.warehouses     || [],
        atRiskProducts: metrics.atRiskProducts || [],
        redemption:     metrics.redemption     || null,
        kpi,
        finance: {
          today: calcFinance(metrics.today?.revenue || 0, metrics.today?.adSpend || 0, finKpi),
          month: calcFinance(metrics.month?.revenue || 0, metrics.month?.adSpend || 0, finKpi),
        },
        source:   metrics.source || "unknown",
        cachedAt: new Date().toISOString(),
      };
      if (metrics.source !== "error") {
        cache.ozon = { data: result, updatedAt: now };
      }
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/credentials/:platform", (req, res) => {
    try {
      const { platform } = req.params;
      if (!['ozon','wb'].includes(platform)) return res.status(400).json({ error: 'Неизвестная платформа' });
      db.deleteApiCredentials(platform);
      cache[platform] = { data: null, updatedAt: 0 };
      if (platform === 'ozon') {
        process.env.OZON_API_KEY = '';
        process.env.OZON_CLIENT_ID = '';
      } else {
        process.env.WB_API_KEY = '';
        process.env.WB_API_TOKEN = '';
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../../webapp/index.html"));
  });

  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`🌐 WebApp запущен на порту ${port}`);
  });

  return {
    stop() { server.close(); }
  };
}

module.exports = { startWebAppServer };
