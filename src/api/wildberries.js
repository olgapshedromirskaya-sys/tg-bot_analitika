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
function buildMockWildberriesMetrics(date = dayjs()) {
  const daySeed    = Number(date.format("YYYYDDD")) + 101;
  const dailyRevenue = round(seededValue(daySeed + 3, 80000, 210000));
  const dailyOrders  = round(seededValue(daySeed + 5, 55, 170));
  const conversion   = round(seededValue(daySeed + 9, 2.5, 4.8), 2);
  const adSpend      = round(seededValue(daySeed + 12, 10000, 29000));
  const dayOfMonth   = date.date();
  return {
    source: "mock",
    channel: "wildberries",
    today: { revenue: dailyRevenue, orders: dailyOrders, conversion, adSpend },
    month: {
      revenue:  round(dailyRevenue * dayOfMonth * seededValue(daySeed + 15, 0.9, 1.22)),
      orders:   round(dailyOrders  * dayOfMonth * seededValue(daySeed + 17, 0.88, 1.16)),
      adSpend:  round(adSpend      * dayOfMonth * seededValue(daySeed + 19, 0.84, 1.12)),
    },
    stocks: [
      { sku: "WB-784", name: "Лосины женские S",    qty: round(seededValue(daySeed + 21, 4, 95)),  daysCover: round(seededValue(daySeed + 25, 2, 35)), warehouseName: "Коледино" },
      { sku: "WB-912", name: "Рюкзак городской 22л", qty: round(seededValue(daySeed + 27, 5, 90)), daysCover: round(seededValue(daySeed + 31, 2, 29)), warehouseName: "Электросталь" },
    ],
    warehouses: [
      { name: "Коледино",      qty: round(seededValue(daySeed + 41, 100, 600)) },
      { name: "Электросталь",  qty: round(seededValue(daySeed + 43, 50, 400)) },
      { name: "Казань",        qty: round(seededValue(daySeed + 45, 20, 200)) },
      { name: "Краснодар",     qty: round(seededValue(daySeed + 47, 10, 150)) },
    ],
    atRiskProducts: [{ name: "Лосины женские S", reason: "Перерасход рекламы при просадке конверсии" }],
  };
}

// ── Реальный WB API ───────────────────────────────────────────────
const WB_STAT_BASE = "https://statistics-api.wildberries.ru/api/v1";
const WB_ADV_BASE  = "https://advert-api.wildberries.ru/adv/v1";
const WB_CONTENT_BASE = "https://suppliers-api.wildberries.ru";

function getToken() {
  return process.env.WB_API_KEY || process.env.WB_API_TOKEN || "";
}
function statHeaders() {
  return { Authorization: getToken(), "Content-Type": "application/json" };
}

// Пауза между запросами чтобы не получать 429
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Продажи за период
async function fetchSales(dateFrom, dateTo) {
  const resp = await axios.get(`${WB_STAT_BASE}/supplier/sales`, {
    headers: statHeaders(),
    params: {
      dateFrom: dateFrom.format("YYYY-MM-DDTHH:mm:ss"),
      dateTo:   dateTo.format("YYYY-MM-DDTHH:mm:ss"),
      flag: 0,
    },
    timeout: 15000,
  });
  return resp.data || [];
}

// Заказы за период
async function fetchOrders(dateFrom, dateTo) {
  const resp = await axios.get(`${WB_STAT_BASE}/supplier/orders`, {
    headers: statHeaders(),
    params: {
      dateFrom: dateFrom.format("YYYY-MM-DDTHH:mm:ss"),
      dateTo:   dateTo.format("YYYY-MM-DDTHH:mm:ss"),
      flag: 0,
    },
    timeout: 15000,
  });
  return resp.data || [];
}

// Расходы на рекламу
async function fetchAdSpend(dateFrom, dateTo) {
  try {
    const resp = await axios.get(`${WB_ADV_BASE}/upd`, {
      headers: statHeaders(),
      params: {
        from: dateFrom.format("YYYY-MM-DD"),
        to:   dateTo.format("YYYY-MM-DD"),
      },
      timeout: 15000,
    });
    const rows = resp.data || [];
    return rows.reduce((sum, r) => sum + (r.updSum || 0), 0);
  } catch {
    return 0;
  }
}

// Остатки по складам
async function fetchStocks() {
  try {
    const resp = await axios.get(`${WB_STAT_BASE}/supplier/stocks`, {
      headers: statHeaders(),
      params: { dateFrom: dayjs().subtract(1, "day").format("YYYY-MM-DDTHH:mm:ss") },
      timeout: 15000,
    });
    const items = resp.data || [];

    // Группируем по складам
    const warehouseMap = {};
    for (const item of items) {
      const wh = item.warehouseName || "Основной";
      warehouseMap[wh] = (warehouseMap[wh] || 0) + (item.quantityFull || 0);
    }

    // Топ товаров по остаткам
    const skuMap = {};
    for (const item of items) {
      const key = item.supplierArticle || item.nmId;
      if (!skuMap[key]) {
        skuMap[key] = {
          sku:           item.supplierArticle || String(item.nmId),
          name:          item.subject || item.supplierArticle || String(item.nmId),
          qty:           0,
          daysCover:     item.daysOnSite || 0,
          warehouseName: item.warehouseName || "Основной",
        };
      }
      skuMap[key].qty += item.quantityFull || 0;
    }

    const stocks = Object.values(skuMap)
      .filter(s => s.qty > 0)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 20);

    const warehouses = Object.entries(warehouseMap)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty);

    return { stocks, warehouses };
  } catch (e) {
    console.error("[WB Stocks] Ошибка:", e.message);
    return { stocks: [], warehouses: [] };
  }
}

// Считаем выручку
function calcRevenue(sales) {
  return sales.reduce((sum, s) => sum + (s.forPay || s.priceWithDisc || 0), 0);
}
function calcConversion(salesCount, ordersCount) {
  if (!ordersCount) return 0;
  return round((salesCount / ordersCount) * 100, 1);
}

// ── Главная функция ───────────────────────────────────────────────
async function getWildberriesMetrics({ date } = {}) {
  const token = getToken();

  if (!token) {
    console.log("[WB] Нет токена, возвращаю демо-данные");
    return buildMockWildberriesMetrics(date ? dayjs(date) : undefined);
  }

  try {
    const now        = date ? dayjs(date) : dayjs();
    const todayStart = now.startOf("day");
    const monthStart = now.startOf("month");

    // Последовательные запросы с паузой — избегаем 429
    const todaySales = await fetchSales(todayStart, now);
    await sleep(500);
    const todayOrders = await fetchOrders(todayStart, now);
    await sleep(500);
    const monthSales = await fetchSales(monthStart, now);
    await sleep(500);
    const monthOrders = await fetchOrders(monthStart, now);
    await sleep(500);
    const monthAdSpend = await fetchAdSpend(monthStart, now);
    await sleep(500);
    const { stocks, warehouses } = await fetchStocks();

    const dayOfMonth       = now.date();
    const todayAdSpend     = dayOfMonth > 0 ? round(monthAdSpend / dayOfMonth) : 0;
    const todayRevenue     = round(calcRevenue(todaySales));
    const todayOrdersCount = todayOrders.length;
    const todaySalesCount  = todaySales.length;
    const monthRevenue     = round(calcRevenue(monthSales));
    const monthOrdersCount = monthOrders.length;

    console.log(`[WB API] Сегодня: выручка=${todayRevenue}, заказы=${todayOrdersCount}, складов=${warehouses.length}`);

    return {
      source:  "api",
      channel: "wildberries",
      today: {
        revenue:    todayRevenue,
        orders:     todayOrdersCount,
        conversion: calcConversion(todaySalesCount, todayOrdersCount),
        adSpend:    todayAdSpend,
      },
      month: {
        revenue:  monthRevenue,
        orders:   monthOrdersCount,
        adSpend:  monthAdSpend,
      },
      stocks,
      warehouses,
      atRiskProducts: [],
    };
  } catch (error) {
    console.error("[WB API] Ошибка:", error.response?.status, error.message);

    if (error.response?.status === 401) {
      return {
        source: "error",
        channel: "wildberries",
        error: "Неверный токен WB. Проверьте ключ в настройках.",
        today: { revenue: 0, orders: 0, conversion: 0, adSpend: 0 },
        month: { revenue: 0, orders: 0, adSpend: 0 },
        stocks: [], warehouses: [], atRiskProducts: [],
      };
    }

    console.log("[WB] Fallback на демо-данные");
    return buildMockWildberriesMetrics(date ? dayjs(date) : undefined);
  }
}

module.exports = { getWildberriesMetrics, buildMockWildberriesMetrics };
