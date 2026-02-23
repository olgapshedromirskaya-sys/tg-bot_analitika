const axios = require("axios");
const dayjs = require("dayjs");

function seededValue(seed, min, max) {
  const x = Math.sin(seed) * 10000;
  const fractional = x - Math.floor(x);
  return min + fractional * (max - min);
}
function round(value, precision = 0) {
  const divider = 10 ** precision;
  return Math.round(value * divider) / divider;
}
function buildMockOzonMetrics(date = dayjs()) {
  const daySeed = Number(date.format("YYYYDDD"));
  const dailyRevenue = round(seededValue(daySeed + 7, 70000, 180000));
  const dailyOrders  = round(seededValue(daySeed + 11, 45, 140));
  const conversion   = round(seededValue(daySeed + 13, 2.2, 4.3), 2);
  const adSpend      = round(seededValue(daySeed + 17, 9000, 26000));
  const dayOfMonth   = date.date();
  return {
    source: "mock",
    channel: "ozon",
    today: { revenue: dailyRevenue, orders: dailyOrders, conversion, adSpend },
    month: {
      revenue:  round(dailyRevenue * dayOfMonth * seededValue(daySeed + 19, 0.9,  1.2)),
      orders:   round(dailyOrders  * dayOfMonth * seededValue(daySeed + 21, 0.9,  1.15)),
      adSpend:  round(adSpend      * dayOfMonth * seededValue(daySeed + 23, 0.85, 1.1)),
    },
    skuAdSpend: {
      "OZ-111": round(adSpend * 0.50),
      "OZ-248": round(adSpend * 0.30),
      "OZ-335": round(adSpend * 0.20),
    },
    stocks: [
      { sku: "OZ-111", name: "Куртка зимняя XL",       qty: round(seededValue(daySeed + 31, 12, 70)),  daysCover: round(seededValue(daySeed + 37, 2,  6)),  warehouseName: "Москва (FBO)",          monthAdSpend: round(adSpend * 0.50), monthOrders: round(seededValue(daySeed + 71, 20, 60)), cpo: round(adSpend * 0.50 / round(seededValue(daySeed + 71, 20, 60))) },
      { sku: "OZ-248", name: "Термокружка 450мл",      qty: round(seededValue(daySeed + 41, 8,  120)), daysCover: round(seededValue(daySeed + 43, 8,  15)), warehouseName: "Санкт-Петербург (FBO)", monthAdSpend: round(adSpend * 0.30), monthOrders: round(seededValue(daySeed + 73, 15, 50)), cpo: round(adSpend * 0.30 / round(seededValue(daySeed + 73, 15, 50))) },
      { sku: "OZ-335", name: "Рюкзак туристический",   qty: round(seededValue(daySeed + 45, 15, 80)),  daysCover: round(seededValue(daySeed + 47, 22, 40)), warehouseName: "Склад продавца (FBS)",  monthAdSpend: round(adSpend * 0.20), monthOrders: round(seededValue(daySeed + 75, 8,  30)),  cpo: round(adSpend * 0.20 / round(seededValue(daySeed + 75, 8,  30))) },
    ],
    warehouses: [
      { name: "Москва (FBO)",          qty: round(seededValue(daySeed + 51, 100, 500)) },
      { name: "Санкт-Петербург (FBO)", qty: round(seededValue(daySeed + 53, 50,  300)) },
      { name: "Екатеринбург (FBO)",    qty: round(seededValue(daySeed + 55, 30,  200)) },
      { name: "Склад продавца (FBS)",  qty: round(seededValue(daySeed + 57, 20,  120)) },
    ],
    atRiskProducts: [
      { name: "Куртка зимняя XL",     sku: "OZ-111", reason: "CTR упал за 24ч, продаж нет 3 дня",         trend: "down", revenueDelta: -41, ordersDelta: -35, ctrDelta: -28 },
      { name: "Термокружка 450мл",    sku: "OZ-248", reason: "Остаток критичен — менее 7 дней покрытия",   trend: "down", revenueDelta: -15, ordersDelta: -19, ctrDelta: -9  },
      { name: "Рюкзак туристический", sku: "OZ-335", reason: "Рост CTR и продаж за последние 7 дней",      trend: "up",   revenueDelta:  52, ordersDelta:  44, ctrDelta:  67 },
    ],
  };
}

const OZON_BASE = "https://api-seller.ozon.ru";

function ozonHeaders() {
  return {
    "Client-Id":    process.env.OZON_CLIENT_ID || "",
    "Api-Key":      process.env.OZON_API_KEY   || "",
    "Content-Type": "application/json",
  };
}

async function fetchOzonAnalytics(dateFrom, dateTo) {
  const resp = await axios.post(
    `${OZON_BASE}/v1/analytics/data`,
    {
      date_from: dateFrom.format("YYYY-MM-DD"),
      date_to:   dateTo.format("YYYY-MM-DD"),
      metrics:   ["revenue", "ordered_units", "session_view_pdp", "conv_tocart_pdp"],
      dimension: ["day"],
      limit: 1000,
    },
    { headers: ozonHeaders(), timeout: 15000 }
  );
  return resp.data?.result?.data || [];
}

// Расходы суммарные — надёжный эндпоинт
async function fetchOzonAdSpend(dateFrom, dateTo) {
  try {
    const resp = await axios.post(
      `${OZON_BASE}/v1/statistics/campaign/product/report`,
      {
        date_from: dateFrom.format("YYYY-MM-DD"),
        date_to:   dateTo.format("YYYY-MM-DD"),
        metrics:   ["expense"],
        dimension: ["day"],
      },
      { headers: ozonHeaders(), timeout: 15000 }
    );
    const rows = resp.data?.result?.data || [];
    return rows.reduce((sum, r) => {
      const exp = (r.metrics || []).find(m => m.key === "expense");
      return sum + (exp?.value || 0);
    }, 0);
  } catch {
    return 0;
  }
}

// Расходы по артикулам — отдельный безопасный запрос, не роняет всё при ошибке
async function fetchOzonAdSpendBySku(dateFrom, dateTo) {
  try {
    const resp = await axios.post(
      `${OZON_BASE}/v1/statistics/campaign/product/report`,
      {
        date_from: dateFrom.format("YYYY-MM-DD"),
        date_to:   dateTo.format("YYYY-MM-DD"),
        metrics:   ["expense", "orders"],
        dimension: ["offer_id"],
      },
      { headers: ozonHeaders(), timeout: 10000 }
    );
    const rows = resp.data?.result?.data || [];
    const skuAdSpend  = {};
    const skuOrders   = {};
    for (const row of rows) {
      const sku = row.dimensions?.[0]?.id;
      if (!sku) continue;
      const expense = (row.metrics || []).find(m => m.key === "expense")?.value || 0;
      const orders  = (row.metrics || []).find(m => m.key === "orders")?.value  || 0;
      skuAdSpend[sku] = (skuAdSpend[sku] || 0) + expense;
      skuOrders[sku]  = (skuOrders[sku]  || 0) + orders;
    }
    return { skuAdSpend, skuOrders };
  } catch (e) {
    console.error("[Ozon AdSpend by SKU] Ошибка (не критично):", e.message);
    return { skuAdSpend: {}, skuOrders: {} };
  }
}

async function fetchOzonStocks() {
  try {
    const resp = await axios.post(
      `${OZON_BASE}/v3/product/info/stocks`,
      { filter: { visibility: "ALL" }, last_id: "", limit: 100 },
      { headers: ozonHeaders(), timeout: 15000 }
    );
    const items = resp.data?.result?.items || [];
    const warehouseMap = {};
    const stocks = [];
    for (const item of items) {
      for (const stock of (item.stocks || [])) {
        const wh = stock.warehouse_name || "Основной склад";
        warehouseMap[wh] = (warehouseMap[wh] || 0) + (stock.present || 0);
      }
      const totalQty = (item.stocks || []).reduce((s, st) => s + (st.present || 0), 0);
      if (totalQty > 0) {
        stocks.push({
          sku:          item.offer_id || String(item.product_id),
          name:         item.name || item.offer_id,
          qty:          totalQty,
          daysCover:    0,
          warehouseName: Object.keys(warehouseMap)[0] || "Склад",
        });
      }
    }
    const warehouses = Object.entries(warehouseMap).map(([name, qty]) => ({ name, qty }));
    return { stocks: stocks.slice(0, 20), warehouses };
  } catch {
    return { stocks: [], warehouses: [] };
  }
}

async function getOzonMetrics({ date } = {}) {
  const clientId = (process.env.OZON_CLIENT_ID || "").trim();
  const apiKey   = (process.env.OZON_API_KEY   || "").trim();

  if (!clientId || !apiKey) {
    console.log("[Ozon] Нет ключей, возвращаю демо-данные");
    return buildMockOzonMetrics(date ? dayjs(date) : undefined);
  }

  try {
    const now        = date ? dayjs(date) : dayjs();
    const todayStart = now.startOf("day");
    const monthStart = now.startOf("month");

    const todayData    = await fetchOzonAnalytics(todayStart, now);
    const monthData    = await fetchOzonAnalytics(monthStart, now);
    const monthAdSpend = await fetchOzonAdSpend(monthStart, now);
    const { stocks, warehouses } = await fetchOzonStocks();

    // CPO по артикулам — безопасно, не роняет всё при ошибке
    const { skuAdSpend, skuOrders } = await fetchOzonAdSpendBySku(monthStart, now);
    for (const s of stocks) {
      const ad     = skuAdSpend[s.sku] || 0;
      const orders = skuOrders[s.sku]  || 0;
      s.monthAdSpend = round(ad);
      s.monthOrders  = orders;
      s.cpo          = (ad > 0 && orders > 0) ? round(ad / orders) : null;
    }

    function sumMetric(data, key) {
      return data.reduce((sum, row) => {
        const m = (row.metrics || []).find(m => m.key === key);
        return sum + (m?.value || 0);
      }, 0);
    }

    const todayRevenue = round(sumMetric(todayData, "revenue"));
    const todayOrders  = round(sumMetric(todayData, "ordered_units"));
    const todayViews   = sumMetric(todayData, "session_view_pdp");
    const todayConv    = todayViews > 0 ? round((todayOrders / todayViews) * 100, 1) : 0;
    const monthRevenue = round(sumMetric(monthData, "revenue"));
    const monthOrders  = round(sumMetric(monthData, "ordered_units"));
    const dayOfMonth   = now.date();
    const todayAdSpend = dayOfMonth > 0 ? round(monthAdSpend / dayOfMonth) : 0;

    console.log(`[Ozon API] Сегодня: выручка=${todayRevenue}, заказы=${todayOrders}`);

    return {
      source:  "api",
      channel: "ozon",
      today: { revenue: todayRevenue, orders: todayOrders, conversion: todayConv, adSpend: todayAdSpend },
      month: { revenue: monthRevenue, orders: monthOrders, adSpend: monthAdSpend },
      skuAdSpend,
      stocks,
      warehouses,
      atRiskProducts: [],
    };
  } catch (error) {
    console.error("[Ozon API] Ошибка:", error.response?.status, error.message);
    if (error.response?.status === 401 || error.response?.status === 403) {
      return {
        source: "error", channel: "ozon",
        error: "Неверные ключи Ozon. Проверьте Client-ID и API-ключ в настройках.",
        today: { revenue: 0, orders: 0, conversion: 0, adSpend: 0 },
        month: { revenue: 0, orders: 0, adSpend: 0 },
        stocks: [], warehouses: [], atRiskProducts: [],
      };
    }
    console.log("[Ozon] Fallback на демо-данные");
    return buildMockOzonMetrics(date ? dayjs(date) : undefined);
  }
}

module.exports = { getOzonMetrics, buildMockOzonMetrics };
