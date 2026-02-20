const axios = require("axios");
const dayjs = require("dayjs");

// ── Моковые данные (fallback если API недоступен) ─────────────────
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
  const daySeed = Number(date.format("YYYYDDD")) + 101;
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
    atRiskProducts: [],
  };
}

// ── Реальный WB Statistics API ────────────────────────────────────
const WB_STAT_BASE = "https://statistics-api.wildberries.ru/api/v1";
const WB_ADV_BASE  = "https://advert-api.wildberries.ru/adv/v1";

function getToken() {
  return process.env.WB_API_KEY || process.env.WB_API_TOKEN || "";
}

function statHeaders() {
  return {
    Authorization: getToken(),
    "Content-Type": "application/json",
  };
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
    return 0; // реклама не обязательна
  }
}

// Считаем выручку из массива продаж
function calcRevenue(sales) {
  return sales.reduce((sum, s) => sum + (s.forPay || s.priceWithDisc || 0), 0);
}

// Считаем конверсию: продажи / заказы * 100
function calcConversion(salesCount, ordersCount) {
  if (!ordersCount) return 0;
  return round((salesCount / ordersCount) * 100, 1);
}

// ── Главная функция ───────────────────────────────────────────────
async function getWildberriesMetrics({ date } = {}) {
  const token = getToken();

  // Если токена нет — сразу мок
  if (!token) {
    console.log("[WB] Нет токена, возвращаю демо-данные");
    return buildMockWildberriesMetrics(date ? dayjs(date) : undefined);
  }

  try {
    const now       = date ? dayjs(date) : dayjs();
    const todayStart = now.startOf("day");
    const monthStart = now.startOf("month");

    // Параллельно запрашиваем всё
    const [todaySales, todayOrders, monthSales, monthOrders, monthAdSpend] =
      await Promise.all([
        fetchSales(todayStart, now),
        fetchOrders(todayStart, now),
        fetchSales(monthStart, now),
        fetchOrders(monthStart, now),
        fetchAdSpend(monthStart, now),
      ]);

    // Расходы на рекламу сегодня (приблизительно — пропорционально дням)
    const dayOfMonth  = now.date();
    const todayAdSpend = dayOfMonth > 0 ? round(monthAdSpend / dayOfMonth) : 0;

    const todayRevenue = round(calcRevenue(todaySales));
    const todayOrdersCount = todayOrders.length;
    const todaySalesCount  = todaySales.length;

    const monthRevenue     = round(calcRevenue(monthSales));
    const monthOrdersCount = monthOrders.length;

    console.log(`[WB API] Сегодня: выручка=${todayRevenue}, заказы=${todayOrdersCount}`);

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
      atRiskProducts: [],
    };
  } catch (error) {
    console.error("[WB API] Ошибка:", error.response?.status, error.message);

    // Если 401 — токен неверный
    if (error.response?.status === 401) {
      return {
        source: "error",
        channel: "wildberries",
        error: "Неверный токен WB. Проверьте ключ в настройках.",
        today: { revenue: 0, orders: 0, conversion: 0, adSpend: 0 },
        month: { revenue: 0, orders: 0, adSpend: 0 },
        atRiskProducts: [],
      };
    }

    // Другие ошибки — fallback на мок
    console.log("[WB] Fallback на демо-данные");
    return buildMockWildberriesMetrics(date ? dayjs(date) : undefined);
  }
}

module.exports = {
  getWildberriesMetrics,
  buildMockWildberriesMetrics,
};