const express = require("express");
const path = require("node:path");

const cache = {
  wb:   { data: null, updatedAt: 0 },
  ozon: { data: null, updatedAt: 0 },
};
const CACHE_TTL_MS = 15 * 60 * 1000;

function startWebAppServer({ db }) {
  const app = express();
  app.use(express.json());
  app.use("/assets", express.static(path.join(__dirname, "../../webapp/assets")));

  app.get("/api/credentials/status", (req, res) => {
    res.json({ ozon: db.hasCredentials("ozon"), wb: db.hasCredentials("wb") });
  });

  app.post("/api/credentials", (req, res) => {
    try {
      const { platform, apiKey, clientId } = req.body;
      if (!platform || !apiKey) return res.status(400).json({ error: "Не указана платформа или ключ" });
      db.saveApiCredentials({ platform, apiKey, clientId: clientId || "" });
      if (platform === "ozon") { process.env.OZON_API_KEY = apiKey; process.env.OZON_CLIENT_ID = clientId || ""; }
      else if (platform === "wb") { process.env.WB_API_KEY = apiKey; process.env.WB_API_TOKEN = apiKey; }
      cache[platform] = { data: null, updatedAt: 0 };
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // KPI — получить все
  app.get("/api/kpi", (req, res) => {
    try { res.json(db.getKpiSettings()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // KPI — получить для конкретной платформы
  app.get("/api/kpi/:platform", (req, res) => {
    try {
      const { platform } = req.params;
      if (!['ozon', 'wb'].includes(platform)) return res.status(400).json({ error: "Неизвестная платформа" });
      res.json(db.getKpiForPlatform(platform));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // KPI — сохранить (сбрасывает кэш обеих платформ)
  app.post("/api/kpi", (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key || value === undefined) return res.status(400).json({ error: "Не указан ключ или значение" });
      db.setKpiValue(key, Number(value));
      cache.ozon = { data: null, updatedAt: 0 };
      cache.wb   = { data: null, updatedAt: 0 };
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/data/wb", async (req, res) => {
    try {
      const creds = db.getApiCredentials("wb");
      const now = Date.now();
      if (cache.wb.data && (now - cache.wb.updatedAt) < CACHE_TTL_MS) { console.log("[WB] Отдаю из кэша"); return res.json(cache.wb.data); }
      if (creds) { process.env.WB_API_KEY = creds.api_key; process.env.WB_API_TOKEN = creds.api_key; }
      else { process.env.WB_API_KEY = ""; process.env.WB_API_TOKEN = ""; }
      delete require.cache[require.resolve("../api/wildberries")];
      const { getWildberriesMetrics } = require("../api/wildberries");
      const metrics = await getWildberriesMetrics();
      const kpi = db.getKpiForPlatform("wb");
      const result = { today: metrics.today||null, month: metrics.month||null, stocks: metrics.stocks||[], warehouses: metrics.warehouses||[], atRiskProducts: metrics.atRiskProducts||[], kpi, source: metrics.source||"unknown", cachedAt: new Date().toISOString() };
      if (metrics.source !== "error") cache.wb = { data: result, updatedAt: now };
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/data/ozon", async (req, res) => {
    try {
      const creds = db.getApiCredentials("ozon");
      const now = Date.now();
      if (cache.ozon.data && (now - cache.ozon.updatedAt) < CACHE_TTL_MS) { console.log("[Ozon] Отдаю из кэша"); return res.json(cache.ozon.data); }
      if (creds) { process.env.OZON_API_KEY = creds.api_key; process.env.OZON_CLIENT_ID = creds.client_id || ""; }
      else { process.env.OZON_API_KEY = ""; process.env.OZON_CLIENT_ID = ""; }
      delete require.cache[require.resolve("../api/ozon")];
      const { getOzonMetrics } = require("../api/ozon");
      const metrics = await getOzonMetrics();
      const kpi = db.getKpiForPlatform("ozon");
      const result = { today: metrics.today||null, month: metrics.month||null, stocks: metrics.stocks||[], warehouses: metrics.warehouses||[], atRiskProducts: metrics.atRiskProducts||[], kpi, source: metrics.source||"unknown", cachedAt: new Date().toISOString() };
      if (metrics.source !== "error") cache.ozon = { data: result, updatedAt: now };
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/credentials/:platform", (req, res) => {
    try {
      const { platform } = req.params;
      if (!['ozon','wb'].includes(platform)) return res.status(400).json({ error: 'Неизвестная платформа' });
      db.deleteApiCredentials(platform);
      cache[platform] = { data: null, updatedAt: 0 };
      if (platform === 'ozon') { process.env.OZON_API_KEY = ''; process.env.OZON_CLIENT_ID = ''; }
      else { process.env.WB_API_KEY = ''; process.env.WB_API_TOKEN = ''; }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "../../webapp/index.html")); });

  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => { console.log(`🌐 WebApp запущен на порту ${port}`); });
  return server;
}

module.exports = { startWebAppServer };
