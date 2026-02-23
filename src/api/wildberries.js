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
    skuAdSpend: {
      "WB-784": round(adSpend * 0.45),
      "WB-912": round(adSpend * 0.35),
      "WB-445": round(adSpend * 0.20),
    },
    redemption: {
      avg: 76,
      bad: [
        { sku: "WB-784", name: "Лосины женские S",     orders: 42, sales: 29, rate: 69 },
        { sku: "WB-912", name: "Рюкзак городской 22л", orders: 35, sales: 25, rate: 71 },
      ],
    },
    stocks: [
      { sku: "WB-784", name: "Лосины женские S",     qty: round(seededValue(daySeed + 21, 4,  95)), daysCover: round(seededValue(daySeed + 25, 2,  13)), warehouseName: "Коледино",             monthAdSpend: round(adSpend * 0.45), monthOrders: round(seededValue(daySeed + 61, 15, 50)), cpo: round(adSpend * 0.45 / Math.max(1, round(seededValue(daySeed + 61, 15, 50)))) },
      { sku: "WB-912", name: "Рюкзак городской 22л", qty: round(seededValue(daySeed + 27, 5,  90)), daysCover: round(seededValue(daySeed + 31, 14, 29)), warehouseName: "Электросталь",         monthAdSpend: round(adSpend * 0.35), monthOrders: round(seededValue(daySeed + 63, 10, 40)), cpo: round(adSpend * 0.35 / Math.max(1, round(seededValue(daySeed + 63, 10, 40)))) },
      { sku: "WB-445", name: "Термос 500мл",         qty: round(seededValue(daySeed + 33, 10, 60)), daysCover: round(seededValue(daySeed + 35, 25, 45)), warehouseName: "Склад продавца (FBS)", monthAdSpend: round(adSpend * 0.20), monthOrders: round(seededValue(daySeed + 65, 5,  25)),  cpo: round(adSpend * 0.20 / Math.max(1, round(seededValue(daySeed + 65, 5,  25)))) },
    ],
    warehouses: [
      { name: "Коледино",             qty: round(seededValue(daySeed + 41, 100, 600)) },
      { name: "Электросталь",         qty: round(seededValue(daySeed + 43, 50,  400)) },
      { name: "Казань",               qty: round(seededValue(daySeed + 45, 20,  200)) },
      { name: "Краснодар",            qty: round(seededValue(daySeed + 47, 10,  150)) },
      { name: "Склад продавца (FBS)", qty: round(seededValue(daySeed + 49, 10,  80))  },
    ],
    atRiskProducts: [
      { name: "Лосины женские S",     sku: "WB-784", reason: "Перерасход рекламы при просадке конверсии", trend: "down", revenueDelta: -23, ordersDelta: -31, ctrDelta: -18 },
      { name: "Рюкзак городской 22л", sku: "WB-912", reason: "Остаток критичен — 7 дней покрытия",        trend: "down", revenueDelta: -12, ordersDelta: -8,  ctrDelta: -5  },
      { name: "Термос 500мл",         sku: "WB-445", reason: "Рост CTR и продаж за последние 7 дней",     trend: "up",   revenueDelta:  34, ordersDelta:  28, ctrDelta:  41 },
    ],
  };
}

const WB_STAT_BASE   = "https://statistics-api.wildberries.ru/api/v1";
const WB_ADV_BASE    = "https://advert-api.wildberries.ru/adv/v1";
const WB_ADV_BASE_V2 = "https://advert-api.wildberries.ru/adv/v2";

function getToken() {
  return process.env.WB_API_KEY || process.env.WB_API_TOKEN || "";
}
function statHeaders() {
  return { Authorization: getToken(), "Content-Type": "application/json" };
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchSales(dateFrom, dateTo) {
  const resp = await axios.get(`${WB_STAT_BASE}/supplier/sales`, {
    headers: statHeaders(),
    params: { dateFrom: dateFrom.format("YYYY-MM-DDTHH:mm:ss"), dateTo: dateTo.format("YYYY-MM-DDTHH:mm:ss"), flag: 0 },
    timeout: 15000,
  });
  return resp.data || [];
}

async function fetchOrders(dateFrom, dateTo) {
  const resp = await axios.get(`${WB_STAT_BASE}/supplier/orders`, {
    headers: statHeaders(),
    params: { dateFrom: dateFrom.format("YYYY-MM-DDTHH:mm:ss"), dateTo: dateTo.format("YYYY-MM-DDTHH:mm:ss"), flag: 0 },
    timeout: 15000,
  });
  return resp.data || [];
}

async function fetchAdSpend(dateFrom, dateTo) {
  try {
    const resp = await axios.get(`${WB_ADV_BASE}/upd`, {
      headers: statHeaders(),
      params: { from: dateFrom.format("YYYY-MM-DD"), to: dateTo.format("YYYY-MM-DD") },
      timeout: 15000,
    });
    const rows = resp.data || [];
    return rows.reduce((sum, r) => sum + (r.updSum || 0), 0);
  } catch {
    return 0;
  }
}

async function fetchAdSpendBySku(dateFrom, dateTo) {
  try {
    const campResp = await axios.get(`${WB_ADV_BASE}/promotion/count`, {
      headers: statHeaders(), timeout: 8000,
    });
    const adverts = campResp.data?.adverts || [];
    const ids = adverts
      .flatMap(g => (g.advert_list || []).map(a => a.advertId))
      .filter(Boolean).slice(0, 50);
    if (!ids.length) return { skuAdSpend: {}, skuOrders: {} };
    await sleep(300);
    const statsResp = await axios.post(
      `${WB_ADV_BASE_V2}/fullstats`,
      ids.map(id => ({ id, dates: [dateFrom.format("YYYY-MM-DD"), dateTo.format("YYYY-MM-DD")] })),
      { headers: statHeaders(), timeout: 15000 }
    );
    const campaigns = statsResp.data || [];
    const skuAdSpend = {};
    const skuOrders  = {};
    for (const camp of campaigns) {
      for (const day of (camp.days || [])) {
        for (const app of (day.apps || [])) {
          for (const nm of (app.nm || [])) {
            const key = String(nm.nmId);
            skuAdSpend[key] = (skuAdSpend[key] || 0) + (nm.sum    || 0);
            skuOrders[key]  = (skuOrders[key]  || 0) + (nm.orders || 0);
          }
        }
      }
    }
    return { skuAdSpend, skuOrders };
  } catch (e) {
    console.error("[WB AdSpend by SKU] Ошибка (не критично):", e.message);
    return { skuAdSpend: {}, skuOrders: {} };
  }
}

async function fetchStocks() {
  try {
    const resp = await axios.get(`${WB_STAT_BASE}/supplier/stocks`, {
      headers: statHeaders(),
      params: { dateFrom: dayjs().subtract(1, "day").format("YYYY-MM-DDTHH:mm:ss") },
      timeout: 15000,
    });
    const items = resp.data || [];
    const warehouseMap = {};
    for (const item of items) {
      const wh = item.warehouseName || "Основной";
      warehouseMap[wh] = (warehouseMap[wh] || 0) + (item.quantityFull || 0);
    }
    const skuMap = {};
    for (const item of items) {
      const key = item.supplierArticle || item.nmId;
      if (!skuMap[key]) {
        skuMap[key] = {
          sku:           item.supplierArticle || String(item.nmId),
          nmId:          String(item.nmId || ""),
          name:          item.subject || item.supplierArticle || String(item.nmId),
          qty:           0,
          daysCover:     item.daysOnSite || 0,
          warehouseName: item.warehouseName || "Основной",
        };
      }
      skuMap[key].qty += item.quantityFull || 0;
    }
    const stocks = Object.values(skuMap).filter(s => s.qty > 0).sort((a, b) => b.qty - a.qty).slice(0, 20);
    const warehouses = Object.entries(warehouseMap).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
    return { stocks, warehouses };
  } catch (e) {
    console.error("[WB Stocks] Ошибка:", e.message);
    return { stocks: [], warehouses: [] };
  }
}

function calcRevenue(sales) {
  return sales.reduce((sum, s) => sum + (s.forPay || s.priceWithDisc || 0), 0);
}
function calcConversion(salesCount, ordersCount) {
  if (!ordersCount) return 0;
  return round((salesCount / ordersCount) * 100, 1);
}
function calcOrdersBySku(orders) {
  const map = {};
  for (const o of orders) {
    const key = o.supplierArticle || String(o.nmId || "");
    if (key) map[key] = (map[key] || 0) + 1;
  }
  return map;
}

// Выкуп% по артикулам — считается из уже загруженных sales и orders, без новых запросов
function calcRedemptionBySku(monthOrders, monthSales, stocks) {
  const THRESHOLD = 80;

  const ordersMap = {};
  for (const o of monthOrders) {
    const key = o.supplierArticle || String(o.nmId || "");
    if (key) ordersMap[key] = (ordersMap[key] || 0) + 1;
  }

  const salesMap = {};
  for (const s of monthSales) {
    const key = s.supplierArticle || String(s.nmId || "");
    if (key) salesMap[key] = (salesMap[key] || 0) + 1;
  }

  const skuNameMap = {};
  for (const s of stocks) {
    skuNameMap[s.sku] = s.name;
    if (s.nmId) skuNameMap[s.nmId] = s.name;
  }

  let totalOrders = 0, totalSales = 0;
  const skuRates = [];

  for (const [sku, orders] of Object.entries(ordersMap)) {
    if (orders < 5) continue;
    const sales = salesMap[sku] || 0;
    const rate  = Math.round(sales / orders * 100);
    totalOrders += orders;
    totalSales  += sales;
    skuRates.push({ sku, name: skuNameMap[sku] || sku, orders, sales, rate });
  }

  const avg = totalOrders > 0 ? Math.round(totalSales / totalOrders * 100) : null;
  const bad = skuRates
    .filter(s => s.rate < THRESHOLD)
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 10);

  return { avg, bad };
}

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

    const todaySales   = await fetchSales(todayStart, now);   await sleep(500);
    const todayOrders  = await fetchOrders(todayStart, now);  await sleep(500);
    const monthSales   = await fetchSales(monthStart, now);   await sleep(500);
    const monthOrders  = await fetchOrders(monthStart, now);  await sleep(500);
    const monthAdSpend = await fetchAdSpend(monthStart, now); await sleep(500);
    const { stocks, warehouses } = await fetchStocks();

    const { skuAdSpend, skuOrders: skuOrdersFromAds } = await fetchAdSpendBySku(monthStart, now);
    const skuOrdersFromStat = calcOrdersBySku(monthOrders);

    for (const s of stocks) {
      const nmId   = s.nmId || s.sku;
      const ad     = skuAdSpend[nmId]    || skuAdSpend[s.sku]    || 0;
      const orders = skuOrdersFromAds[nmId] || skuOrdersFromStat[s.sku] || skuOrdersFromStat[nmId] || 0;
      s.monthAdSpend = round(ad);
      s.monthOrders  = orders;
      s.cpo          = (ad > 0 && orders > 0) ? round(ad / orders) : null;
    }

    // Выкуп% — без новых API запросов, из уже загруженных данных
    const redemption = calcRedemptionBySku(monthOrders, monthSales, stocks);

    const dayOfMonth       = now.date();
    const todayAdSpend     = dayOfMonth > 0 ? round(monthAdSpend / dayOfMonth) : 0;
    const todayRevenue     = round(calcRevenue(todaySales));
    const todayOrdersCount = todayOrders.length;
    const monthRevenue     = round(calcRevenue(monthSales));
    const monthOrdersCount = monthOrders.length;

    console.log(`[WB API] Сегодня: выручка=${todayRevenue}, заказы=${todayOrdersCount}, выкуп=${redemption.avg}%`);

    return {
      source:  "api",
      channel: "wildberries",
      today: { revenue: todayRevenue, orders: todayOrdersCount, conversion: calcConversion(todaySales.length, todayOrdersCount), adSpend: todayAdSpend },
      month: { revenue: monthRevenue, orders: monthOrdersCount, adSpend: monthAdSpend },
      skuAdSpend,
      redemption,
      stocks,
      warehouses,
      atRiskProducts: [],
    };
  } catch (error) {
    console.error("[WB API] Ошибка:", error.response?.status, error.message);
    if (error.response?.status === 401) {
      return {
        source: "error", channel: "wildberries",
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
