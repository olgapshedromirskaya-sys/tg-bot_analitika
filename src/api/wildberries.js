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
    // skuAdSpend для демо — распределяем бюджет по артикулам
    skuAdSpend: {
      "WB-784": round(adSpend * 0.45),
      "WB-912": round(adSpend * 0.35),
      "WB-445": round(adSpend * 0.20),
    },
    stocks: [
      { sku: "WB-784", name: "Лосины женские S",     qty: round(seededValue(daySeed + 21, 4,  95)), daysCover: round(seededValue(daySeed + 25, 2,  13)), warehouseName: "Коледино",             orders: round(seededValue(daySeed + 61, 15, 50)) },
      { sku: "WB-912", name: "Рюкзак городской 22л", qty: round(seededValue(daySeed + 27, 5,  90)), daysCover: round(seededValue(daySeed + 31, 14, 29)), warehouseName: "Электросталь",         orders: round(seededValue(daySeed + 63, 10, 40)) },
      { sku: "WB-445", name: "Термос 500мл",         qty: round(seededValue(daySeed + 33, 10, 60)), daysCover: round(seededValue(daySeed + 35, 25, 45)), warehouseName: "Склад продавца (FBS)", orders: round(seededValue(daySeed + 65, 5,  25)) },
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

// ── Реальный WB API ───────────────────────────────────────────────
const WB_STAT_BASE    = "https://statistics-api.wildberries.ru/api/v1";
const WB_ADV_BASE     = "https://advert-api.wildberries.ru/adv/v1";
const WB_ADV_BASE_V2  = "https://advert-api.wildberries.ru/adv/v2";
const WB_CONTENT_BASE = "https://suppliers-api.wildberries.ru";

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
    params: {
      dateFrom: dateFrom.format("YYYY-MM-DDTHH:mm:ss"),
      dateTo:   dateTo.format("YYYY-MM-DDTHH:mm:ss"),
      flag: 0,
    },
    timeout: 15000,
  });
  return resp.data || [];
}

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

// Суммарные расходы на рекламу (для общего CPO)
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

// Расходы на рекламу по артикулам (nmId) — для CPO по SKU
// Используем /adv/v2/fullstats — статистика по кампаниям с разбивкой по товарам
async function fetchAdSpendBySku(dateFrom, dateTo) {
  try {
    // Шаг 1: получаем список активных кампаний
    const campResp = await axios.get(`${WB_ADV_BASE}/promotion/count`, {
      headers: statHeaders(),
      timeout: 10000,
    });
    const adverts = campResp.data?.adverts || [];
    // Собираем id всех кампаний (статусы 4=активна, 11=на паузе, 9=завершена)
    const ids = adverts
      .flatMap(group => (group.advert_list || []).map(a => a.advertId))
      .filter(Boolean)
      .slice(0, 50); // API принимает до 50 за раз

    if (!ids.length) return {};

    await sleep(300);

    // Шаг 2: fullstats по этим кампаниям
    const statsResp = await axios.post(
      `${WB_ADV_BASE_V2}/fullstats`,
      ids.map(id => ({
        id,
        dates: [dateFrom.format("YYYY-MM-DD"), dateTo.format("YYYY-MM-DD")],
      })),
      { headers: statHeaders(), timeout: 20000 }
    );

    const campaigns = statsResp.data || [];
    const skuAdSpend = {};

    for (const camp of campaigns) {
      for (const day of (camp.days || [])) {
        for (const app of (day.apps || [])) {
          for (const nm of (app.nm || [])) {
            const nmId = String(nm.nmId);
            skuAdSpend[nmId] = (skuAdSpend[nmId] || 0) + (nm.sum || 0);
          }
        }
      }
    }

    return skuAdSpend; // { "12345678": 1500.5, ... }
  } catch (e) {
    console.error("[WB AdSpend by SKU] Ошибка:", e.message);
    return {};
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
          nmId:          String(item.nmId || ""),  // сохраняем nmId для матчинга с рекламой
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

// Заказы по артикулам за период — для CPO знаменателя
function calcOrdersBySku(orders) {
  const skuOrders = {};
  for (const o of orders) {
    const key = o.supplierArticle || String(o.nmId || "");
    if (key) skuOrders[key] = (skuOrders[key] || 0) + 1;
  }
  return skuOrders;
}

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

    const todaySales   = await fetchSales(todayStart, now);   await sleep(500);
    const todayOrders  = await fetchOrders(todayStart, now);  await sleep(500);
    const monthSales   = await fetchSales(monthStart, now);   await sleep(500);
    const monthOrders  = await fetchOrders(monthStart, now);  await sleep(500);
    const monthAdSpend = await fetchAdSpend(monthStart, now); await sleep(500);

    // Расходы по артикулам — за месяц (более репрезентативно чем за день)
    const skuAdSpend   = await fetchAdSpendBySku(monthStart, now); await sleep(500);

    const { stocks, warehouses } = await fetchStocks();

    // Заказы по артикулам за месяц — для CPO знаменателя
    const skuOrdersMap = calcOrdersBySku(monthOrders);

    // Добавляем в каждый stock: adSpend и orders за месяц → CPO
    for (const s of stocks) {
      const nmId   = s.nmId || s.sku;
      const ad     = skuAdSpend[nmId]    || skuAdSpend[s.sku]    || 0;
      const orders = skuOrdersMap[s.sku] || skuOrdersMap[nmId]   || 0;
      s.monthAdSpend  = round(ad);
      s.monthOrders   = orders;
      s.cpo           = orders > 0 ? round(ad / orders) : null;
    }

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
      skuAdSpend,
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
