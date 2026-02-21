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

function makeBar(current, plan, length = 10) {
  const safePlan = plan <= 0 ? 1 : plan;
  const ratio = Math.max(0, Math.min(1, current / safePlan));
  const filled = Math.round(ratio * length);
  const over = current > safePlan;
  const fillChar = over ? "🟨" : "🟩";
  return `${fillChar.repeat(filled)}${"⬜".repeat(length - filled)}`;
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

function formatChannelBlock(channel, label, emoji) {
  const t = channel.today || {};
  const lines = [
    `${emoji} <b>${label}</b> · ${channel.source === "api" ? "реальные данные" : "демо"}`,
    `💰 Выручка: <b>${formatCompactMoney(t.revenue)}</b>`,
    `📦 Заказы: <b>${Math.round(t.orders || 0)}</b>`,
    `📢 Реклама: <b>${formatCompactMoney(t.adSpend)}</b>`,
    `🔄 Конверсия: <b>${Number(t.conversion || 0).toFixed(1)}%</b>`,
  ];

  const risk = (channel.atRiskProducts || []).filter(p => p.trend === "down")[0];
  if (risk) {
    lines.push(`🚨 Риск: <b>${risk.name}</b> — ${risk.reason}`);
  }

  const growth = (channel.atRiskProducts || []).filter(p => p.trend === "up")[0];
  if (growth) {
    lines.push(`📈 Рост: <b>${growth.name}</b> — ${growth.reason}`);
  }

  return lines.join("\n");
}

function formatStatsMessage(snapshot, kpi) {
  const channels = snapshot.channels || [];
  const ozon = channels[0];
  const wb   = channels[1];

  // Показываем только платформы с реальными ключами (source === "api")
  // Если обе в демо — показываем обе (нет ни одного ключа)
  const hasAnyApi = channels.some(c => c.source === "api");
  const visibleChannels = hasAnyApi
    ? channels.filter(c => c.source === "api")
    : channels;

  const lines = [
    "🤖 <b>MarketBot Analytics</b>",
    `${dayjs().format("DD.MM.YYYY")}`,
    "",
  ];

  for (const channel of visibleChannels) {
    const isOzon = channel === ozon;
    const label  = isOzon ? "Ozon" : "Wildberries";
    const emoji  = isOzon ? "🔵" : "🟣";
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push(formatChannelBlock(channel, label, emoji));
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━");

  return lines.join("\n");
}

function formatChannelMonthBlock(channel, label, emoji, kpi) {
  const plans = getMonthPlans(kpi);
  const m = channel.month || {};
  const revenueLine = `${formatMoney(m.revenue)} / ${formatMoney(plans.revenue)}`;
  const adLine      = `${formatMoney(m.adSpend)} / ${formatMoney(plans.adBudget)}`;
  const ordersLine  = `${Math.round(m.orders || 0).toLocaleString("ru-RU")} / ${Math.round(plans.orders).toLocaleString("ru-RU")}`;

  return [
    `${emoji} <b>${label}</b>`,
    "",
    `💰 Выручка / план: <b>${revenueLine}</b>`,
    `${makeBar(m.revenue, plans.revenue)}`,
    "",
    `📢 Рекламный бюджет: <b>${adLine}</b>`,
    `${makeBar(m.adSpend, plans.adBudget)}`,
    "",
    `📦 Выполнение плана заказов: <b>${ordersLine}</b>`,
    `${makeBar(m.orders, plans.orders)}`,
  ].join("\n");
}

function formatMonthMessage(snapshot, kpi) {
  const channels = snapshot.channels || [];
  const ozon = channels[0];
  const wb   = channels[1];

  const hasAnyApi = channels.some(c => c.source === "api");
  const visibleChannels = hasAnyApi
    ? channels.filter(c => c.source === "api")
    : channels;

  const lines = [
    "📈 <b>Месячный отчёт</b>",
    `${dayjs().format("DD.MM.YYYY")}`,
    "",
  ];

  for (const channel of visibleChannels) {
    const isOzon = channel === ozon;
    const label  = isOzon ? "Ozon" : "Wildberries";
    const emoji  = isOzon ? "🔵" : "🟣";
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push(formatChannelMonthBlock(channel, label, emoji, kpi));
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

function formatChannelStocksBlock(channel, label, emoji) {
  const stocks = (channel.stocks || []).slice(0, 5);
  if (!stocks.length) return `${emoji} <b>${label}</b>\nДанные по остаткам недоступны.`;

  const lines = [`${emoji} <b>${label}</b>`, ""];
  for (const item of stocks) {
    const status = item.daysCover <= 5 ? "🔴 критично" : item.daysCover <= 12 ? "🟡 контроль" : "🟢 стабильно";
    lines.push(
      `• <b>${item.name}</b> (${item.sku})`,
      `  Остаток: ${Math.round(item.qty)} шт · Покрытие: ${Math.round(item.daysCover)} дн · ${status}`,
    );
  }
  return lines.join("\n");
}

function formatStocksMessage(snapshot) {
  const channels = snapshot.channels || [];
  const ozon = channels[0];
  const wb   = channels[1];

  const hasAnyApi = channels.some(c => c.source === "api");
  const visibleChannels = hasAnyApi
    ? channels.filter(c => c.source === "api")
    : channels;

  const lines = [
    "📦 <b>Остатки на складах</b>",
    `${dayjs().format("DD.MM.YYYY")}`,
    "",
  ];

  for (const channel of visibleChannels) {
    const isOzon = channel === ozon;
    const label  = isOzon ? "Ozon" : "Wildberries";
    const emoji  = isOzon ? "🔵" : "🟣";
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push(formatChannelStocksBlock(channel, label, emoji));
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━");
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
