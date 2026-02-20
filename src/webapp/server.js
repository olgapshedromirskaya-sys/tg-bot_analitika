const express = require("express");
const path = require("node:path");
const dayjs = require("dayjs");

function startWebAppServer({ db }) {
  const app = express();

  app.use(express.json());

  // Статические файлы из webapp/assets (app.js, styles.css)
  app.use(
    "/assets",
    express.static(path.join(__dirname, "../../webapp/assets"))
  );

  // ── /api/webapp/dashboard — главный эндпоинт для app.js ─────────
  app.get("/api/webapp/dashboard", async (req, res) => {
    try {
      const kpi = db.getKpiSettings();

      // Загружаем данные WB (основная площадка на демо)
      const wbCreds = db.getApiCredentials("wb");
      if (wbCreds) {
        process.env.WB_API_KEY   = wbCreds.api_key;
        process.env.WB_API_TOKEN = wbCreds.api_key;
        if (wbCreds.client_id) {
          process.env.WB_METRICS_URL = wbCreds.client_id;
        }
      }

      const ozonCreds = db.getApiCredentials("ozon");
      if (ozonCreds) {
        process.env.OZON_API_KEY   = ozonCreds.api_key;
        process.env.OZON_CLIENT_ID = ozonCreds.client_id || "";
      }

      // Получаем метрики WB
      delete require.cache[require.resolve("../api/wildberries")];
      const { getWildberriesMetrics } = require("../api/wildberries");
      const wb = await getWildberriesMetrics();

      const today = wb.today || {};
      const month = wb.month || {};

      // Считаем дельты и прогрессы
      const revenuePlan    = kpi.revenue    || 5000000;
      const adBudgetPlan   = kpi.ad_budget  || 100000;
      const dailyOrders    = kpi.daily_orders || 100;
      const ordersPlanMonth = dailyOrders * 30;
      const conversionPlan = kpi.conversion  || 3.5;

      // Дневной план выручки = месячный / 30
      const dayRevenuePlan = revenuePlan / 30;
      const revenueDeltaGoalPercent =
        dayRevenuePlan > 0
          ? ((today.revenue - dayRevenuePlan) / dayRevenuePlan) * 100
          : 0;

      // Дельта заказов — разница с планом на день
      const ordersDeltaYesterday = today.orders - dailyOrders;

      // Использование рекламного бюджета
      const adBudgetUsagePercent =
        adBudgetPlan > 0 ? (today.adSpend / adBudgetPlan) * 100 : 0;

      // Дельта конверсии
      const conversionDeltaYesterday = today.conversion - conversionPlan;

      // Прогрессы за месяц
      const revenueProgress =
        revenuePlan > 0
          ? Math.min(month.revenue / revenuePlan, 1)
          : 0;
      const adBudgetProgress =
        adBudgetPlan > 0
          ? Math.min((month.adSpend || today.adSpend) / adBudgetPlan, 1)
          : 0;
      const ordersProgress =
        ordersPlanMonth > 0
          ? Math.min(month.orders / ordersPlanMonth, 1)
          : 0;

      // Алерт — берём первый проблемный товар если есть
      const riskProduct = wb.atRiskProducts?.[0];
      const riskAlert = {
        title:   riskProduct?.name    || "Данные в норме",
        message: riskProduct?.reason  || "Все показатели в пределах нормы",
      };

      // Определяем источник данных
      const isRealApi = wb.source === "api";
      const hasWbKey  = db.hasCredentials("wb");
      const hasOzonKey = db.hasCredentials("ozon");

      const channels = [];
      if (hasOzonKey) channels.push("Ozon");
      if (hasWbKey)   channels.push("Wildberries");

      const payload = {
        status: {
          apiIntegrationLabel: isRealApi
            ? "🟢 API-интеграция активна"
            : "🟡 API-интеграция активна (демо)",
          channelsLabel: channels.length > 0
            ? channels.join(" · ")
            : "Ozon · Wildberries · демо-режим",
        },
        hero: {
          subtitle: hasWbKey || hasOzonKey
            ? "Реальные данные ваших магазинов"
            : "Подключите API в настройках бота",
        },
        today: {
          revenue:                today.revenue  || 0,
          revenueDeltaGoalPercent,
          orders:                 today.orders   || 0,
          ordersDeltaYesterday,
          adSpend:                today.adSpend  || 0,
          adBudgetUsagePercent,
          conversion:             today.conversion || 0,
          conversionDeltaYesterday,
        },
        riskAlert,
        month: {
          revenue: {
            value:    month.revenue || 0,
            plan:     revenuePlan,
            progress: revenueProgress,
          },
          adBudget: {
            value:    month.adSpend || today.adSpend || 0,
            plan:     adBudgetPlan,
            progress: adBudgetProgress,
          },
          orders: {
            value:    month.orders || 0,
            plan:     ordersPlanMonth,
            progress: ordersProgress,
          },
        },
        impact: {
          metricViewTimeSec:      30,
          hoursSavedMonthly:      100,
          profitGrowthPercent:    15,
          adLossReductionPercent: -30,
        },
        ctaUrl:      "https://t.me/your_bot",
        generatedAt: new Date().toISOString(),
      };

      res.json(payload);
    } catch (e) {
      console.error("[dashboard]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Статус API-ключей ────────────────────────────────────────────
  app.get("/api/credentials/status", (req, res) => {
    res.json({
      ozon: db.hasCredentials("ozon"),
      wb:   db.hasCredentials("wb"),
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
        process.env.OZON_API_KEY   = apiKey;
        process.env.OZON_CLIENT_ID = clientId || "";
      } else if (platform === "wb") {
        process.env.WB_API_KEY   = apiKey;
        process.env.WB_API_TOKEN = apiKey;
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── KPI ──────────────────────────────────────────────────────────
  app.get("/api/kpi", (req, res) => {
    try {
      res.json(db.getKpiSettings());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

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

  // ── Данные Ozon отдельно ─────────────────────────────────────────
  app.get("/api/data/ozon", async (req, res) => {
    try {
      const creds = db.getApiCredentials("ozon");
      if (!creds) {
        return res.status(400).json({ error: "Ключи Ozon не настроены. Перейдите в Настройки." });
      }
      process.env.OZON_API_KEY   = creds.api_key;
      process.env.OZON_CLIENT_ID = creds.client_id || "";

      delete require.cache[require.resolve("../api/ozon")];
      const { getOzonMetrics } = require("../api/ozon");
      const metrics = await getOzonMetrics();
      const kpi     = db.getKpiSettings();
      res.json({ today: metrics.today || null, month: metrics.month || null, kpi });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Данные WB отдельно ───────────────────────────────────────────
  app.get("/api/data/wb", async (req, res) => {
    try {
      const creds = db.getApiCredentials("wb");
      if (!creds) {
        return res.status(400).json({ error: "Ключ WB не настроен. Перейдите в Настройки." });
      }
      process.env.WB_API_KEY   = creds.api_key;
      process.env.WB_API_TOKEN = creds.api_key;

      delete require.cache[require.resolve("../api/wildberries")];
      const { getWildberriesMetrics } = require("../api/wildberries");
      const metrics = await getWildberriesMetrics();
      const kpi     = db.getKpiSettings();
      res.json({ today: metrics.today || null, month: metrics.month || null, kpi });
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