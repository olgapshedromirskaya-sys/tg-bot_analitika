const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const dayjs = require("dayjs");
const { getAnalyticsSnapshot } = require("../api/analytics");

const WEBAPP_ROOT = path.join(process.cwd(), "webapp");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, precision = 0) {
  const divider = 10 ** precision;
  return Math.round(value * divider) / divider;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getMonthPlans(kpi) {
  const daysInMonth = dayjs().daysInMonth();
  const monthRevenuePlan = toNumber(kpi.revenue);
  const monthAdBudgetPlan = toNumber(kpi.ad_budget);
  const monthOrdersPlan = toNumber(kpi.daily_orders) * daysInMonth;

  return {
    daysInMonth,
    monthRevenuePlan,
    monthAdBudgetPlan,
    monthOrdersPlan,
    dayRevenuePlan: monthRevenuePlan / Math.max(daysInMonth, 1),
  };
}

function buildDashboardPayload(snapshot, previousSnapshot, kpi) {
  const plans = getMonthPlans(kpi);

  const revenueDeltaGoalPercent =
    ((toNumber(snapshot.today.revenue) / Math.max(plans.dayRevenuePlan, 1)) - 1) * 100;
  const ordersDeltaYesterday =
    toNumber(snapshot.today.orders) - toNumber(previousSnapshot?.today?.orders);
  const conversionDeltaYesterday =
    toNumber(snapshot.today.conversion) - toNumber(previousSnapshot?.today?.conversion);
  const adBudgetUsagePercent =
    (toNumber(snapshot.month.adSpend) / Math.max(plans.monthAdBudgetPlan, 1)) * 100;

  const riskProduct = snapshot.atRiskProducts?.[0];
  const dataMode = snapshot.sources.includes("api") ? "online" : "demo";

  return {
    generatedAt: new Date().toISOString(),
    dataMode,
    status: {
      apiIntegrationLabel:
        dataMode === "online" ? "API-интеграция активна" : "API-интеграция активна (демо)",
      channelsLabel: `Ozon · Wildberries · ${dataMode === "online" ? "онлайн" : "демо-режим"}`,
    },
    hero: {
      title: "Telegram-бот для маркетплейсов",
      subtitle:
        "Аналитика Ozon и Wildberries прямо в мессенджере. Контроль KPI, уведомления об отклонениях и автоматические отчёты — без входа в личные кабинеты.",
    },
    today: {
      revenue: round(toNumber(snapshot.today.revenue)),
      revenueDeltaGoalPercent: round(revenueDeltaGoalPercent, 0),
      orders: round(toNumber(snapshot.today.orders)),
      ordersDeltaYesterday: round(ordersDeltaYesterday, 0),
      adSpend: round(toNumber(snapshot.today.adSpend)),
      adBudgetUsagePercent: round(adBudgetUsagePercent, 0),
      conversion: round(toNumber(snapshot.today.conversion), 1),
      conversionDeltaYesterday: round(conversionDeltaYesterday, 1),
    },
    riskAlert: riskProduct
      ? {
          title: `Товар «${riskProduct.name}» — потеря позиций`,
          message: riskProduct.reason,
        }
      : {
          title: "Критичных отклонений не найдено",
          message: "Система продолжает мониторинг KPI по расписанию.",
        },
    month: {
      revenue: {
        value: round(toNumber(snapshot.month.revenue)),
        plan: round(plans.monthRevenuePlan),
        progress: round(
          clamp(toNumber(snapshot.month.revenue) / Math.max(plans.monthRevenuePlan, 1), 0, 1),
          4,
        ),
      },
      adBudget: {
        value: round(toNumber(snapshot.month.adSpend)),
        plan: round(plans.monthAdBudgetPlan),
        progress: round(
          clamp(toNumber(snapshot.month.adSpend) / Math.max(plans.monthAdBudgetPlan, 1), 0, 1),
          4,
        ),
      },
      orders: {
        value: round(toNumber(snapshot.month.orders)),
        plan: round(plans.monthOrdersPlan),
        progress: round(
          clamp(toNumber(snapshot.month.orders) / Math.max(plans.monthOrdersPlan, 1), 0, 1),
          4,
        ),
      },
    },
    impact: {
      metricViewTimeSec: 30,
      hoursSavedMonthly: 10,
      profitGrowthPercent: 15,
      adLossReductionPercent: -30,
    },
    ctaUrl: process.env.CTA_TELEGRAM_URL || process.env.WEBAPP_CTA_URL || "https://t.me",
    channels: snapshot.channels,
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function sendStaticFile(pathname, res) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  let absolutePath = path.resolve(WEBAPP_ROOT, `.${normalizedPath}`);

  if (!absolutePath.startsWith(WEBAPP_ROOT)) {
    return false;
  }

  try {
    let fileStat = await fs.stat(absolutePath);
    if (fileStat.isDirectory()) {
      absolutePath = path.join(absolutePath, "index.html");
      fileStat = await fs.stat(absolutePath);
    }

    if (!fileStat.isFile()) {
      return false;
    }

    const content = await fs.readFile(absolutePath);
    const ext = path.extname(absolutePath).toLowerCase();

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control":
        ext === ".html" ? "no-cache, no-store, must-revalidate" : "public, max-age=3600",
    });
    res.end(content);
    return true;
  } catch (error) {
    return false;
  }
}

function startWebAppServer({ db }) {
  const host = process.env.WEBAPP_HOST || "0.0.0.0";
  const port = toNumber(process.env.PORT || process.env.WEBAPP_PORT, 3000);

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { ok: false, error: "Bad request" });
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;

    try {
      if (pathname === "/api/webapp/health") {
        sendJson(res, 200, { ok: true, timestamp: new Date().toISOString() });
        return;
      }

      if (pathname === "/api/webapp/dashboard") {
        if (req.method !== "GET") {
          sendJson(res, 405, { ok: false, error: "Method not allowed" });
          return;
        }

        const [snapshot, previousSnapshot] = await Promise.all([
          getAnalyticsSnapshot(),
          getAnalyticsSnapshot({ date: dayjs().subtract(1, "day") }),
        ]);
        const kpi = db.getKpiSettings();
        const payload = buildDashboardPayload(snapshot, previousSnapshot, kpi);
        sendJson(res, 200, payload);
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const served = await sendStaticFile(pathname, res);
        if (served) {
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: "Internal server error" });
      console.error("WebApp server error:", error);
    }
  });

  server.listen(port, host, () => {
    console.log(`🌐 WebApp is available on http://${host}:${port}`);
  });

  return {
    stop() {
      server.close();
    },
    host,
    port,
  };
}

module.exports = {
  startWebAppServer,
  buildDashboardPayload,
};
