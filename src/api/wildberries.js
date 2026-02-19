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
  const daySeed = Number(date.format("YYYYDDD")) + 101;
  const dailyRevenue = round(seededValue(daySeed + 3, 80000, 210000));
  const dailyOrders = round(seededValue(daySeed + 5, 55, 170));
  const conversion = round(seededValue(daySeed + 9, 2.5, 4.8), 2);
  const adSpend = round(seededValue(daySeed + 12, 10000, 29000));

  const dayOfMonth = date.date();
  const monthRevenue = round(dailyRevenue * dayOfMonth * seededValue(daySeed + 15, 0.9, 1.22));
  const monthOrders = round(dailyOrders * dayOfMonth * seededValue(daySeed + 17, 0.88, 1.16));
  const monthAdSpend = round(adSpend * dayOfMonth * seededValue(daySeed + 19, 0.84, 1.12));

  return {
    source: "mock",
    channel: "wildberries",
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
        sku: "WB-784",
        name: "Лосины женские S",
        qty: round(seededValue(daySeed + 21, 4, 95)),
        daysCover: round(seededValue(daySeed + 25, 2, 35)),
      },
      {
        sku: "WB-912",
        name: "Рюкзак городской 22л",
        qty: round(seededValue(daySeed + 27, 5, 90)),
        daysCover: round(seededValue(daySeed + 31, 2, 29)),
      },
    ],
    atRiskProducts: [
      {
        name: "Лосины женские S",
        reason: "Перерасход рекламы при просадке конверсии",
      },
    ],
  };
}

async function fetchFromCustomEndpoint() {
  const endpoint = process.env.WB_METRICS_URL;
  if (!endpoint) {
    return null;
  }

  const response = await axios.get(endpoint, {
    timeout: 9000,
    headers: {
      Authorization: process.env.WB_API_TOKEN || "",
    },
  });

  return response.data;
}

async function getWildberriesMetrics() {
  try {
    const custom = await fetchFromCustomEndpoint();
    if (custom) {
      return { source: "api", channel: "wildberries", ...custom };
    }
  } catch (error) {
    // Silent fallback to mock keeps the bot available.
  }

  return buildMockWildberriesMetrics();
}

module.exports = {
  getWildberriesMetrics,
  buildMockWildberriesMetrics,
};
