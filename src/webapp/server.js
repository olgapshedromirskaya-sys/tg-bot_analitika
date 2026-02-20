const express = require("express");
const path = require("node:path");

function startWebAppServer({ db }) {
  const app = express();

  app.use(express.json());

  // Статические файлы из webapp/assets (app.js, styles.css)
  app.use("/assets", express.static(path.join(__dirname, "../../webapp/assets")));

  // ── Статус API-ключей ────────────────────────────────────────────
  app.get("/api/credentials/status", (req, res) => {
    res.json({
      ozon: db.hasCredentials("ozon"),
      wb: db.hasCredentials("wb"),
    });
  });

  // ── Сохранить API-ключи ──────────────────────────────────────────
  app.post("/api/credentials", (req, res) => {
    try {
      const { platform, apiKey, clientId } = req.body;
      if (!platform || !apiKey) {
        return res.status(400).json({ error: "Не указана платформа или ключ" });
      }
      db.saveApiCredentials({ platform, apiKey, clientId: clientId || "" });

      if (platform === "ozon") {
        process.env.OZON_API_KEY = apiKey;
        process.env.OZON_CLIENT_ID = clientId || "";
      } else if (platform === "wb") {
        process.env.WB_API_KEY   = apiKey;
        process.env.WB_API_TOKEN = apiKey; // wb.js использует WB_API_TOKEN
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Получить KPI ─────────────────────────────────────────────────
  app.get("/api/kpi", (req, res) => {
    try {
      res.json(db.getKpiSettings());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Сохранить KPI ────────────────────────────────────────────────
  app.post("/api/kpi", (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key || value === undefined) {
        return res.status(400).json({ error: "Не указан ключ или значение" });
      }
      db.setKpiValue(key, Number(value));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Данные Ozon ──────────────────────────────────────────────────
  app.get("/api/data/ozon", async (req, res) => {
    try {
      const creds = db.getApiCredentials("ozon");

      // Подставляем ключи из БД в окружение
      if (creds) {
        process.env.OZON_API_KEY   = creds.api_key;
        process.env.OZON_CLIENT_ID = creds.client_id || "";
      }

      const { getOzonMetrics } = require("../api/ozon");
      const metrics = await getOzonMetrics();
      const kpi     = db.getKpiSettings();

      // Приводим к единому формату { today, month, kpi }
      res.json({
        today: metrics.today || null,
        month: metrics.month || null,
        kpi,
        source: metrics.source || "unknown",
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Данные Wildberries ───────────────────────────────────────────
  app.get("/api/data/wb", async (req, res) => {
    try {
      const creds = db.getApiCredentials("wb");

      // Подставляем ключи из БД в окружение
      if (creds) {
        process.env.WB_API_KEY   = creds.api_key;
        process.env.WB_API_TOKEN = creds.api_key; // wb.js читает WB_API_TOKEN
        process.env.WB_METRICS_URL = creds.client_id || ""; // client_id используем как endpoint URL если нужен
      }

      const { getWildberriesMetrics } = require("../api/wildberries");
      const metrics = await getWildberriesMetrics();
      const kpi     = db.getKpiSettings();

      // Приводим к единому формату { today, month, kpi }
      res.json({
        today:  metrics.today  || null,
        month:  metrics.month  || null,
        kpi,
        source: metrics.source || "unknown",
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Главная страница ─────────────────────────────────────────────
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../../webapp/index.html"));
  });

  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`🌐 WebApp запущен на порту ${port}`);
  });

  return server;
}

module.exports = { startWebAppServer };