const express = require("express");
const path = require("node:path");
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const cache = {
  wb: { data: null, updatedAt: 0 },
  ozon: { data: null, updatedAt: 0 }
};

const CACHE_TTL_MS = 15 * 60 * 1000;

function createFallbackDb() {
  return {
    getUserByTelegramId: () => null,
    hasCredentials: () => false,
    saveApiCredentials: () => {},
    getApiCredentials: () => null,
    deleteApiCredentials: () => {},
    getKpiSettings: () => ({}),
    getKpiByPlatform: () => ({}),
    setKpiValue: () => {},
    setKpiForPlatform: () => {},
    setFinanceForPlatform: () => {},
    deleteAllProductCosts: () => {},
    upsertProductCost: () => {},
    getProductCosts: () => [],
    deleteCommissions: () => {},
    upsertCommission: () => {},
    getCommissions: () => [],
    getAvgCommission: () => null
  };
}

function calcFinance(revenue, adSpend, kpi = {}) {
  if (!revenue) {
    return { cost: 0, commission: 0, adSpend: 0, netProfit: 0, margin: 0, isHealthy: false };
  }

  const costPct = Number(kpi.cost_percent || 40);
  const commRate = Number(kpi.commission || 15);
  const minProfit = Number(kpi.min_profitability || 10);

  const cost = revenue * (costPct / 100);
  const commission = revenue * (commRate / 100);
  const ad = adSpend || 0;
  const netProfit = revenue - cost - commission - ad;
  const margin = (netProfit / revenue) * 100;

  return {
    cost,
    commission,
    adSpend: ad,
    netProfit,
    margin,
    isHealthy: margin >= minProfit
  };
}

function startWebAppServer(options = {}) {
  const db = options.db || createFallbackDb();
  const app = express();

  app.use(express.json());
  app.use("/assets", express.static(path.join(__dirname, "../../webapp/assets")));

  app.get("/api/me", (req, res) => {
    res.json({ role: "guest", telegramId: null, name: null });
  });

  app.get("/api/credentials/status", (req, res) => {
    res.json({
      ozon: db.hasCredentials("ozon"),
      wb: db.hasCredentials("wb")
    });
  });

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
      }

      if (platform === "wb") {
        process.env.WB_API_KEY = apiKey;
        process.env.WB_API_TOKEN = apiKey;
      }

      cache[platform] = { data: null, updatedAt: 0 };

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

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

  app.get("/api/kpi/:platform", (req, res) => {
    try {
      const { platform } = req.params;

      if (!["ozon", "wb"].includes(platform)) {
        return res.status(400).json({ error: "Неизвестная платформа" });
      }

      res.json(db.getKpiByPlatform(platform));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/kpi/:platform", (req, res) => {
    try {
      const { platform } = req.params;

      if (!["ozon", "wb"].includes(platform)) {
        return res.status(400).json({ error: "Неизвестная платформа" });
      }

      const { revenue, conversion, ad_budget, daily_orders } = req.body;

      db.setKpiForPlatform(platform, {
        revenue,
        conversion,
        ad_budget,
        daily_orders
      });

      cache[platform] = { data: null, updatedAt: 0 };

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/finance/:platform", (req, res) => {
    try {
      const { platform } = req.params;

      if (!["ozon", "wb"].includes(platform)) {
        return res.status(400).json({ error: "Неизвестная платформа" });
      }

      const { commission, min_profitability, cost_percent } = req.body;

      db.setFinanceForPlatform(platform, {
        commission,
        min_profitability,
        cost_percent
      });

      cache[platform] = { data: null, updatedAt: 0 };

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/costs/upload", upload.single("file"), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Файл не загружен" });
      }

      const text = req.file.buffer.toString("utf8").replace(/\r/g, "");
      const lines = text.split("\n").filter((line) => line.trim());
      const sep = lines[0]?.includes(";") ? ";" : ",";
      const startIdx = isNaN(lines[0]?.split(sep)[0].trim()) ? 1 : 0;

      db.deleteAllProductCosts();

      let imported = 0;
      const errors = [];

      for (let i = startIdx; i < lines.length; i++) {
        const parts = lines[i].split(sep).map((s) => s.trim().replace(/^["']|["']$/g, ""));
        const sku = parts[0];
        const name = parts[1] || "";
        const rawCost = parts.length >= 3 ? parts[2] : parts[1];
        const cost = parseFloat((rawCost || "0").replace(",", "."));

        if (!sku) continue;

        if (isNaN(cost)) {
          errors.push(`Строка ${i + 1}: неверная себестоимость`);
          continue;
        }

        db.upsertProductCost({ sku, name, cost });
        imported++;
      }

      res.json({ ok: true, imported, errors });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/costs", (req, res) => {
    try {
      res.json(db.getProductCosts());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/costs", (req, res) => {
    try {
      db.deleteAllProductCosts();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/data/wb", async (req, res) => {
    try {
      const now = Date.now();

      if (cache.wb.data && now - cache.wb.updatedAt < CACHE_TTL_MS) {
        return res.json(cache.wb.data);
      }

      let metrics = {};

      try {
        delete require.cache[require.resolve("../api/wildberries")];
        const { getWildberriesMetrics } = require("../api/wildberries");
        metrics = await getWildberriesMetrics();
      } catch (e) {
        metrics = { source: "demo", error: e.message };
      }

      const kpi = db.getKpiByPlatform("wb") || db.getKpiSettings();
      const avgComm = db.getAvgCommission("wb");
      const finKpi = { ...kpi, commission: avgComm ?? kpi.commission };

      const result = {
        today: metrics.today || null,
        month: metrics.month || null,
        stocks: metrics.stocks || [],
        warehouses: metrics.warehouses || [],
        atRiskProducts: metrics.atRiskProducts || [],
        redemption: metrics.redemption || null,
        kpi,
        finance: {
          today: calcFinance(metrics.today?.revenue || 0, metrics.today?.adSpend || 0, finKpi),
          month: calcFinance(metrics.month?.revenue || 0, metrics.month?.adSpend || 0, finKpi)
        },
        source: metrics.source || "unknown",
        cachedAt: new Date().toISOString()
      };

      cache.wb = { data: result, updatedAt: now };

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/data/ozon", async (req, res) => {
    try {
      const now = Date.now();

      if (cache.ozon.data && now - cache.ozon.updatedAt < CACHE_TTL_MS) {
        return res.json(cache.ozon.data);
      }

      let metrics = {};

      try {
        delete require.cache[require.resolve("../api/ozon")];
        const { getOzonMetrics } = require("../api/ozon");
        metrics = await getOzonMetrics();
      } catch (e) {
        metrics = { source: "demo", error: e.message };
      }

      const kpi = db.getKpiByPlatform("ozon") || db.getKpiSettings();
      const avgComm = db.getAvgCommission("ozon");
      const finKpi = { ...kpi, commission: avgComm ?? kpi.commission };

      const result = {
        today: metrics.today || null,
        month: metrics.month || null,
        stocks: metrics.stocks || [],
        warehouses: metrics.warehouses || [],
        atRiskProducts: metrics.atRiskProducts || [],
        redemption: metrics.redemption || null,
        kpi,
        finance: {
          today: calcFinance(metrics.today?.revenue || 0, metrics.today?.adSpend || 0, finKpi),
          month: calcFinance(metrics.month?.revenue || 0, metrics.month?.adSpend || 0, finKpi)
        },
        source: metrics.source || "unknown",
        cachedAt: new Date().toISOString()
      };

      cache.ozon = { data: result, updatedAt: now };

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/credentials/:platform", (req, res) => {
    try {
      const { platform } = req.params;

      if (!["ozon", "wb"].includes(platform)) {
        return res.status(400).json({ error: "Неизвестная платформа" });
      }

      db.deleteApiCredentials(platform);
      cache[platform] = { data: null, updatedAt: 0 };

      if (platform === "ozon") {
        process.env.OZON_API_KEY = "";
        process.env.OZON_CLIENT_ID = "";
      }

      if (platform === "wb") {
        process.env.WB_API_KEY = "";
        process.env.WB_API_TOKEN = "";
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../../webapp/index.html"));
  });

  const port = Number(process.env.PORT || 8080);

  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`🌐 WebApp запущен на порту ${port}`);
  });

  return {
    stop() {
      server.close();
    }
  };
}

if (require.main === module) {
  startWebAppServer();
}

module.exports = { startWebAppServer };
