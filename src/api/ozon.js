const axios = require("axios");
const dayjs = require("dayjs");

// ── Моковые данные (fallback) ─────────────────────────────────────
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
      revenue:  round(dailyRevenue * dayOfMonth * seededValue(daySeed + 19, 0.9, 1.2)),
      orders:   round(dailyOrders  * dayOfMonth * seededValue(daySeed + 21, 0.9, 1.15)),
      adSpend:  round(adSpend      * dayOfMonth * seededValue(daySeed + 23, 0.85, 1.1)),
    },
    stocks: [
      { sku: "OZ-111", name: "Куртка зимняя XL",   qty: round(seededValue(daySeed + 31, 12, 70)),  daysCover: round(seededValue(daySeed + 37, 4, 22)), warehouseName: "Москва" },
      { sku: "OZ-248", name: "Термокружка 450мл",  qty: round(seededValue(daySeed + 41, 8, 120)),  daysCover: round(seededValue(daySeed + 43, 3, 40)), warehouseName: "Санкт-Петербург" },
    ],
    warehouses: [
      { name: "Москва",          qty: round(seededValue(daySeed + 51, 100, 500)) },
      { name: "Санкт-Петербург", qty: round(seededValue(daySeed + 53, 50, 300)) },
      { name: "Екатеринбург",    qty: round(seededValue(daySeed + 55, 30, 200)) },
    ],
    atRiskProducts: [{ name: "Куртка зимняя XL", reason: "CTR упал за 24ч, продаж нет 3 дня" }],
  };
}

// ── Реальный Ozon API ─────────────────────────────────────────────
const OZON_BASE = "https://api-seller.ozon.ru";

function ozonHeaders() {
  return {
    "Client-Id": process.env.OZON_CLIENT_ID || "",
    "Api-Key":   process.env.OZON_API_KEY   || "",
    "Content-Type": "application/json",
  };
}

// Аналитика продаж
async function fetchOzonAnalytics(dateFrom, dateTo) {
  const resp = await axios.post(
    `${OZON_BASE}/v1/analytics/data`,
    {
      date_from:  dateFrom.format("YYYY-MM-DD"),
      date_to:    dateTo.format("YYYY-MM-DD"),
      metrics:    ["revenue", "ordered_units", "session_view_pdp", "conv_tocart_pdp"],
      dimension:  ["day"],
      limit: 1000,
    },
    { headers: ozonHeaders(), timeout: 15000 }
  );
  return resp.data?.result?.data || [];
}

// Расходы на рекламу
async function fetchOzonAdSpend(dateFrom, dateTo) {
  try {
    const resp = await axios.post(
      `${OZON_BASE}/v1/statistics/campaign/product/report`,
      {
        date_from: dateFrom.format("YYYY-MM-DD"),
        date_to:   dateTo.format("YYYY-MM-DD"),
        metrics:   ["views", "clicks", "orders", "revenue", "expense"],
        dimension: ["day"],
      },
      { headers: ozonHeaders(), timeout: 15000 }
    );
    const rows = resp.data?.result?.data || [];
    return rows.reduce((sum, r) => {
      const exp = r.metrics?.find(m => m.key === "expense");
      return sum + (exp?.value || 0);
    }, 0);
  } catch {
    return 0;
  }
}

// Остатки на складах
async function fetchOzonStocks() {
  try {
    const resp = await axios.post(
      `${OZON_BASE}/v3/product/info/stocks`,
      { filter: { visibility: "ALL" }, last_id: "", limit: 100 },
      { headers: ozonHeaders(), timeout: 15000 }
    );
    const items = resp.data?.result?.items || [];

    // Группируем по складам
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
          sku:  item.offer_id || String(item.product_id),
          name: item.name || item.offer_id,
          qty:  totalQty,
          daysCover: 0, // Ozon не отдаёт daysCover напрямую
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

// ── Главная функция ───────────────────────────────────────────────
async function getOzonMetrics({ date } = {}) {
  const clientId = process.env.OZON_CLIENT_ID;
  const apiKey   = process.env.OZON_API_KEY;

  if (!clientId || !apiKey) {
    console.log("[Ozon] Нет ключей, возвращаю демо-данные");
    return buildMockOzonMetrics(date ? dayjs(date) : undefined);
  }

  try {
    const now        = date ? dayjs(date) : dayjs();
    const todayStart = now.startOf("day");
    const monthStart = now.startOf("month");

    // Последовательные запросы чтобы не получить 429
    const todayData = await fetchOzonAnalytics(todayStart, now);
    const monthData = await fetchOzonAnalytics(monthStart, now);
    const monthAdSpend = await fetchOzonAdSpend(monthStart, now);
    const { stocks, warehouses } = await fetchOzonStocks();

    // Суммируем метрики за сегодня
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
      today: {
        revenue:    todayRevenue,
        orders:     todayOrders,
        conversion: todayConv,
        adSpend:    todayAdSpend,
      },
      month: {
        revenue:  monthRevenue,
        orders:   monthOrders,
        adSpend:  monthAdSpend,
      },
      stocks,
      warehouses,
      atRiskProducts: [],
    };
  } catch (error) {
    console.error("[Ozon API] Ошибка:", error.response?.status, error.message);

    if (error.response?.status === 401 || error.response?.status === 403) {
      return {
        source: "error",
        channel: "ozon",
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
