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
  const dailyOrders = round(seededValue(daySeed + 11, 45, 140));
  const conversion = round(seededValue(daySeed + 13, 2.2, 4.3), 2);
  const adSpend = round(seededValue(daySeed + 17, 9000, 26000));

  const dayOfMonth = date.date();
  const monthRevenue = round(dailyRevenue * dayOfMonth * seededValue(daySeed + 19, 0.9, 1.2));
  const monthOrders = round(dailyOrders * dayOfMonth * seededValue(daySeed + 21, 0.9, 1.15));
  const monthAdSpend = round(adSpend * dayOfMonth * seededValue(daySeed + 23, 0.85, 1.1));

  return {
    source: "mock",
    channel: "ozon",
    today: {
      revenue: dailyRevenue,
      orders: dailyOrders,
      conversion,
      adSpend,
    },
    month: {
      revenue: monthRevenue,
      orders: monthOrders,
      adSpend: monthAdSpend,
    },
    stocks: [
      {
        sku: "OZ-111",
        name: "Куртка зимняя XL",
        qty: round(seededValue(daySeed + 31, 12, 70)),
        daysCover: round(seededValue(daySeed + 37, 4, 22)),
      },
      {
        sku: "OZ-248",
        name: "Термокружка 450мл",
        qty: round(seededValue(daySeed + 41, 8, 120)),
        daysCover: round(seededValue(daySeed + 43, 3, 40)),
      },
    ],
    atRiskProducts: [
      {
        name: "Куртка зимняя XL",
        reason: "CTR упал за 24ч, продаж нет 3 дня",
      },
    ],
  };
}

async function fetchFromCustomEndpoint() {
  const endpoint = process.env.OZON_METRICS_URL;
  if (!endpoint) {
    return null;
  }

  const response = await axios.get(endpoint, {
    timeout: 9000,
    headers: {
      "Client-Id": process.env.OZON_CLIENT_ID || "",
      "Api-Key": process.env.OZON_API_KEY || "",
    },
  });

  return response.data;
}

async function getOzonMetrics() {
  try {
    const custom = await fetchFromCustomEndpoint();
    if (custom) {
      return { source: "api", channel: "ozon", ...custom };
    }
  } catch (error) {
    // Silent fallback to mock keeps the bot available.
  }

  return buildMockOzonMetrics();
}

module.exports = {
  getOzonMetrics,
  buildMockOzonMetrics,
};
