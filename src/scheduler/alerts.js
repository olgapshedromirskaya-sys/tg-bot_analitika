const dayjs = require("dayjs");

function buildAlerts(snapshot, kpi) {
  const alerts = [];
  const now = dayjs();
  const daysInMonth = now.daysInMonth();
  const elapsedDays = now.date();

  const conversionPlan = Number(kpi.conversion || 0);
  const adBudgetPlan = Number(kpi.ad_budget || 0);
  const monthRevenuePlan = Number(kpi.revenue || 0);
  const dayOrdersPlan = Number(kpi.daily_orders || 0);

  if (conversionPlan > 0 && snapshot.today.conversion < conversionPlan * 0.7) {
    alerts.push({
      code: "conversion_low",
      message:
        `🔔 <b>Конверсия ниже порога</b>\n` +
        `Факт: <b>${snapshot.today.conversion.toFixed(2)}%</b>, ` +
        `порог: <b>${(conversionPlan * 0.7).toFixed(2)}%</b>`,
    });
  }

  if (adBudgetPlan > 0 && snapshot.month.adSpend >= adBudgetPlan * 0.85) {
    alerts.push({
      code: "ad_budget_high",
      message:
        `⚠️ <b>Рекламный бюджет почти исчерпан</b>\n` +
        `Израсходовано: <b>${Math.round((snapshot.month.adSpend / adBudgetPlan) * 100)}%</b>`,
    });
  }

  if (monthRevenuePlan > 0) {
    const expectedRevenueByDate = (monthRevenuePlan / daysInMonth) * elapsedDays;
    if (snapshot.month.revenue < expectedRevenueByDate * 0.6) {
      alerts.push({
        code: "month_revenue_lagging",
        message:
          `📉 <b>Выручка отстаёт от плана</b>\n` +
          `Факт: <b>${Math.round(snapshot.month.revenue).toLocaleString("ru-RU")} ₽</b>\n` +
          `Ожидалось к дате: <b>${Math.round(expectedRevenueByDate).toLocaleString("ru-RU")} ₽</b>`,
      });
    }
  }

  if (dayOrdersPlan > 0 && snapshot.today.orders < dayOrdersPlan * 0.4) {
    alerts.push({
      code: "orders_low",
      message:
        `📦 <b>Заказов значительно меньше плана</b>\n` +
        `Факт: <b>${Math.round(snapshot.today.orders)}</b>, ` +
        `план: <b>${dayOrdersPlan}</b>`,
    });
  }

  if (snapshot.atRiskProducts.length > 0) {
    const atRisk = snapshot.atRiskProducts[0];
    alerts.push({
      code: "product_at_risk",
      message:
        `🚨 <b>Товар в зоне риска</b>\n` +
        `<b>${atRisk.name}</b>\n${atRisk.reason}`,
    });
  }

  return alerts;
}

module.exports = {
  buildAlerts,
};
