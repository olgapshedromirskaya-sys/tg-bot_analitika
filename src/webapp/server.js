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
        process.env.WB_API_KEY = apiKey;
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Получить KPI ─────────────────────────────────────────────────
  app.get("/api/kpi", (req, res) => {
    try {
      const kpi = db.getKpiSettings();
      res.json(kpi);
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
      if (!creds) {
        return res.status(400).json({
          error: "Ключи Ozon не настроены. Перейдите в Настройки.",
        });
      }

      process.env.OZON_API_KEY = creds.api_key;
      process.env.OZON_CLIENT_ID = creds.client_id || "";

      delete require.cache[require.resolve("../api/ozon")];
      const ozonApi = require("../api/ozon");

      const [todayResult, monthResult] = await Promise.allSettled([
        ozonApi.getTodaySummary(),
        ozonApi.getMonthlySummary(),
      ]);

      const kpi = db.getKpiSettings();

      res.json({
        today: todayResult.status === "fulfilled" ? todayResult.value : null,
        month: monthResult.status === "fulfilled" ? monthResult.value : null,
        kpi,
        error: todayResult.status === "rejected" ? todayResult.reason?.message : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Данные Wildberries ───────────────────────────────────────────
  app.get("/api/data/wb", async (req, res) => {
    try {
      const creds = db.getApiCredentials("wb");
      if (!creds) {
        return res.status(400).json({
          error: "Ключ WB не настроен. Перейдите в Настройки.",
        });
      }

      process.env.WB_API_KEY = creds.api_key;

      delete require.cache[require.resolve("../api/wildberries")];
      const wbApi = require("../api/wildberries");

      const [todayResult, monthResult] = await Promise.allSettled([
        wbApi.getTodaySummary(),
        wbApi.getMonthlySummary(),
      ]);

      const kpi = db.getKpiSettings();

      res.json({
        today: todayResult.status === "fulfilled" ? todayResult.value : null,
        month: monthResult.status === "fulfilled" ? monthResult.value : null,
        kpi,
        error: todayResult.status === "rejected" ? todayResult.reason?.message : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Главная страница → webapp/index.html ─────────────────────────
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