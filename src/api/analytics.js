const { getOzonMetrics } = require("./ozon");
const { getWildberriesMetrics } = require("./wildberries");

function round(value, precision = 0) {
  const divider = 10 ** precision;
  return Math.round(value * divider) / divider;
}

function mergeStocks(channels) {
  return channels
    .flatMap((channel) => channel.stocks || [])
    .sort((a, b) => Number(a.daysCover) - Number(b.daysCover));
}

function mergeAtRiskProducts(channels) {
  return channels.flatMap((channel) => channel.atRiskProducts || []);
}

function weightedAverage(values) {
  let numerator = 0;
  let denominator = 0;

  for (const item of values) {
    numerator += item.value * item.weight;
    denominator += item.weight;
  }

  if (denominator === 0) {
    return 0;
  }

  return numerator / denominator;
}

async function getAnalyticsSnapshot() {
  const [ozon, wildberries] = await Promise.all([
    getOzonMetrics(),
    getWildberriesMetrics(),
  ]);

  const channels = [ozon, wildberries];

  const todayRevenue = channels.reduce((acc, item) => acc + Number(item.today?.revenue || 0), 0);
  const todayOrders = channels.reduce((acc, item) => acc + Number(item.today?.orders || 0), 0);
  const todayAdSpend = channels.reduce((acc, item) => acc + Number(item.today?.adSpend || 0), 0);
  const todayConversion = weightedAverage(
    channels.map((item) => ({
      value: Number(item.today?.conversion || 0),
      weight: Number(item.today?.orders || 0),
    })),
  );

  const monthRevenue = channels.reduce((acc, item) => acc + Number(item.month?.revenue || 0), 0);
  const monthOrders = channels.reduce((acc, item) => acc + Number(item.month?.orders || 0), 0);
  const monthAdSpend = channels.reduce((acc, item) => acc + Number(item.month?.adSpend || 0), 0);

  return {
    channels,
    sources: Array.from(new Set(channels.map((item) => item.source || "mock"))),
    today: {
      revenue: round(todayRevenue),
      orders: round(todayOrders),
      adSpend: round(todayAdSpend),
      conversion: round(todayConversion, 2),
    },
    month: {
      revenue: round(monthRevenue),
      orders: round(monthOrders),
      adSpend: round(monthAdSpend),
    },
    stocks: mergeStocks(channels),
    atRiskProducts: mergeAtRiskProducts(channels),
  };
}

module.exports = {
  getAnalyticsSnapshot,
};
