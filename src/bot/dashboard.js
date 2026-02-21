const dayjs = require("dayjs");

function formatCompactMoney(value) {
  const abs = Math.abs(Number(value || 0));
  if (abs >= 1_000_000) {
    return `₽${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `₽${(value / 1_000).toFixed(0)}K`;
  }
  return `₽${Math.round(value)}`;
}

function formatMoney(value) {
  return `₽${Math.round(Number(value || 0)).toLocaleString("ru-RU")}`;
}

function formatSigned(value, digits = 0) {
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? "+" : ""}${rounded}${digits > 0 ? "" : ""}`;
}

function makeBar(current, plan, length = 18) {
  const safePlan = plan <= 0 ? 1 : plan;
  const ratio = Math.max(0, Math.min(1, current / safePlan));
  const filled = Math.round(ratio * length);
  return `${"█".repeat(filled)}${"░".repeat(length - filled)}`;
}

function getMonthPlans(kpi) {
  const now = dayjs();
  const daysInMonth = now.daysInMonth();

  return {
    revenue: Number(kpi.revenue || 0),
    adBudget: Number(kpi.ad_budget || 0),
    orders: Number(kpi.daily_orders || 0) * daysInMonth,
  };
}

function formatHeroMessage() {
  return [
    "🤖 <b>API-интеграция активна</b>",
    "",
    "<b>Telegram-бот для маркетплейсов</b>",
    "Аналитика Ozon и Wildberries прямо в мессенджере.",
    "Контроль KPI, уведомления об отклонениях и автоматические отчёты.",
    "",
    "🔵 Ozon API   ✈️ Telegram Bot   🟣 Wildberries API",
    "",
    "<b>Как это работает</b>",
    "01 — 🔗 Подключение по API",
    "02 — 📊 Сбор показателей по расписанию",
    "03 — 🎯 Сравнение факта с планом KPI",
    "04 — 🔔 Умные уведомления при отклонениях",
    "",
    "Нажмите кнопку <b>📊 Дашборд за сегодня</b> чтобы открыть статистику.",
  ].join("\n");
}

function formatStatsMessage(snapshot, kpi) {
  const plans = getMonthPlans(kpi);
  const dailyRevenuePlan = plans.revenue / dayjs().daysInMonth();
  const revenueDelta = ((snapshot.today.revenue / Math.max(dailyRevenuePlan, 1)) - 1) * 100;
  const ordersDelta = snapshot.today.orders - Number(kpi.daily_orders || 0);
  const adUsage = (snapshot.month.adSpend / Math.max(plans.adBudget, 1)) * 100;
  const conversionDelta = snapshot.today.conversion - Number(kpi.conversion || 0);

  const riskProduct = snapshot.atRiskProducts[0];
  const dataSource = snapshot.sources.includes("api") ? "API" : "демо-режим";

  const lines = [
    "🤖 <b>MarketBot Analytics</b>",
    `Ozon · Wildberries · ${dataSource}`,
    "",
    "💰 <b>Выручка сегодня</b>",
    `<b>${formatCompactMoney(snapshot.today.revenue)}</b>`,
    `▲ ${formatSigned(revenueDelta, 0)}% к цели`,
    "",
    "📦 <b>Заказы</b>",
    `<b>${Math.round(snapshot.today.orders)}</b>`,
    `${ordersDelta >= 0 ? "▲" : "▼"} ${formatSigned(ordersDelta)} от плана`,
    "",
    "📢 <b>Расходы на рекламу</b>",
    `<b>${formatCompactMoney(snapshot.today.adSpend)}</b>`,
    `${adUsage >= 85 ? "⚠" : "●"} ${Math.round(adUsage)}% бюджета`,
    "",
    "🔄 <b>Конверсия</b>",
    `<b>${snapshot.today.conversion.toFixed(1)}%</b>`,
    `${conversionDelta >= 0 ? "▲" : "▼"} ${formatSigned(conversionDelta, 1)} п.п.`,
  ];

  if (riskProduct) {
    lines.push(
      "",
      "🚨 <b>Товар в риске</b>",
      `<b>${riskProduct.name}</b> — ${riskProduct.reason}`,
    );
  }

  return lines.join("\n");
}

function formatMonthMessage(snapshot, kpi) {
  const plans = getMonthPlans(kpi);
  const revenueLine = `${formatMoney(snapshot.month.revenue)} / ${formatMoney(plans.revenue)}`;
  const adLine = `${formatMoney(snapshot.month.adSpend)} / ${formatMoney(plans.adBudget)}`;
  const ordersLine = `${Math.round(snapshot.month.orders).toLocaleString("ru-RU")} / ${Math.round(plans.orders).toLocaleString("ru-RU")}`;

  return [
    "📈 <b>Месячный отчёт</b>",
    "",
    `Выручка / план: <b>${revenueLine}</b>`,
    `${makeBar(snapshot.month.revenue, plans.revenue)}`,
    "",
    `Рекламный бюджет: <b>${adLine}</b>`,
    `${makeBar(snapshot.month.adSpend, plans.adBudget)}`,
    "",
    `Выполнение плана заказов: <b>${ordersLine}</b>`,
    `${makeBar(snapshot.month.orders, plans.orders)}`,
    "",
    "Ключевые эффекты:",
    "• 30с — просмотр показателей",
    "• 10ч — экономия в месяц",
    "• +15% — потенциал роста прибыли",
    "• −30% — снижение потерь на рекламе",
  ].join("\n");
}

function formatStocksMessage(snapshot) {
  if (!snapshot.stocks.length) {
    return "📦 <b>Остатки</b>\nДанные по остаткам пока недоступны.";
  }

  const top = snapshot.stocks.slice(0, 8);
  const lines = ["📦 <b>Остатки на складах</b>", ""];

  for (const item of top) {
    const status =
      item.daysCover <= 5 ? "🔴 критично" : item.daysCover <= 12 ? "🟡 контроль" : "🟢 стабильно";
    lines.push(
      `• <b>${item.name}</b> (${item.sku})`,
      `  Остаток: ${Math.round(item.qty)} шт · Покрытие: ${Math.round(item.daysCover)} дн · ${status}`,
    );
  }

  return lines.join("\n");
}

function formatSettingsMessage(kpi) {
  return [
    "⚙️ <b>Текущие KPI</b>",
    `• Выручка (мес): <b>${formatMoney(kpi.revenue)}</b>`,
    `• Конверсия: <b>${Number(kpi.conversion).toFixed(2)}%</b>`,
    `• Рекламный бюджет (мес): <b>${formatMoney(kpi.ad_budget)}</b>`,
    `• Заказы (день): <b>${Math.round(kpi.daily_orders)}</b>`,
  ].join("\n");
}

module.exports = {
  formatHeroMessage,
  formatStatsMessage,
  formatMonthMessage,
  formatStocksMessage,
  formatSettingsMessage,
  formatMoney,
};
