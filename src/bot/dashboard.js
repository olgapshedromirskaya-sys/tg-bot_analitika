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

function calcDrr(adSpend, revenue) {
  if (!revenue || revenue === 0) return 0;
  return (adSpend / revenue) * 100;
}

function formatDrr(adSpend, revenue) {
  const drr = calcDrr(adSpend, revenue);
  const status = drr === 0 ? "" : drr <= 10 ? " 🟢" : drr <= 20 ? " 🟡" : " 🔴";
  return `ДРР: <b>${drr.toFixed(1)}%</b>${status}`;
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
  const drr = calcDrr(t.adSpend, t.revenue);
  const drrStatus = drr === 0 ? "" : drr <= 10 ? " 🟢" : drr <= 20 ? " 🟡" : " 🔴";
  const lines = [
    `${emoji} <b>${label}</b> · ${channel.source === "api" ? "реальные данные" : "демо"}`,
    `💰 Выручка: <b>${formatCompactMoney(t.revenue)}</b>`,
    `📦 Заказы: <b>${Math.round(t.orders || 0)}</b>`,
    `📢 Реклама: <b>${formatCompactMoney(t.adSpend)}</b>`,
    `📊 ДРР: <b>${drr.toFixed(1)}%</b>${drrStatus}`,
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

  const drrMonth = calcDrr(m.adSpend, m.revenue);
  const drrMonthStatus = drrMonth === 0 ? "" : drrMonth <= 10 ? " 🟢" : drrMonth <= 20 ? " 🟡" : " 🔴";
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
    "",
    `📊 ДРР за месяц: <b>${drrMonth.toFixed(1)}%</b>${drrMonthStatus} <i>(норма до 10%)</i>`,
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

function calcWarehouseSupply(warehouses, totalQtyToOrder) {
  // Распределяем пропорционально продажам (qty = прокси продаж по складу):
  // где больше продаж — туда больше везём
  if (!warehouses || !warehouses.length || totalQtyToOrder <= 0) return [];

  const totalSales = warehouses.reduce((s, w) => s + (w.qty || 0), 0) || 1;

  return warehouses
    .map(w => ({
      name: w.name,
      qty:  Math.round(totalQtyToOrder * (w.qty || 0) / totalSales),
    }))
    .filter(w => w.qty > 0);
}

function formatChannelStocksBlock(channel, label, emoji, kpi) {
  const stocks = (channel.stocks || []).slice(0, 5);
  if (!stocks.length) return `${emoji} <b>${label}</b>\nДанные по остаткам недоступны.`;

  const SUPPLY_DAYS = (kpi && kpi.supply_days > 0) ? Number(kpi.supply_days) : 14;
  const TARGET_DAYS = 30; // целевой запас 30 дней продаж
  const channelWarehouses = channel.warehouses || [];

  const lines = [`${emoji} <b>${label}</b>`, ""];

  for (const item of stocks) {
    const status = item.daysCover <= 5 ? "🔴 критично" : item.daysCover <= 12 ? "🟡 контроль" : "🟢 стабильно";

    const dailySales = item.daysCover > 0 ? item.qty / item.daysCover : 0;
    const totalQtyToOrder = Math.max(0, Math.round(dailySales * TARGET_DAYS - item.qty));
    const daysUntilOrder = item.daysCover - SUPPLY_DAYS;

    lines.push(`• <b>${item.name}</b> · арт. ${item.sku}`);
    lines.push(`  Остаток: ${Math.round(item.qty)} шт · Покрытие: ${Math.round(item.daysCover)} дн · ${status}`);

    if (item.daysCover < SUPPLY_DAYS) {
      // Срочно — разбиваем по складам
      lines.push(`  🚨 <b>Поставка срочно!</b> Догрузить: ${totalQtyToOrder} шт`);
      // Распределяем по складам пропорционально дефициту
      const whs1 = calcWarehouseSupply(channelWarehouses, totalQtyToOrder);
      if (whs1.length > 0) {
        for (const wh of whs1) {
          lines.push(`    📦 Догрузить на <b>${wh.name}</b>: <b>${wh.qty} шт</b>`);
        }
      } else {
        lines.push(`    📦 Догрузить на <b>${item.warehouseName || "склад"}</b>: <b>${totalQtyToOrder} шт</b>`);
      }
    } else if (item.daysCover < SUPPLY_DAYS + 7) {
      const orderDate = new Date();
      orderDate.setDate(orderDate.getDate() + Math.max(0, daysUntilOrder));
      const dateStr = orderDate.toLocaleDateString("ru", { day: "numeric", month: "short" });
      lines.push(`  ⚡ <b>Поставка:</b> отгрузить <b>${dateStr}</b> · Догрузить: ${totalQtyToOrder} шт`);
      const whs2 = calcWarehouseSupply(channelWarehouses, totalQtyToOrder);
      if (whs2.length > 0) {
        for (const wh of whs2) {
          lines.push(`    📦 На <b>${wh.name}</b>: <b>${wh.qty} шт</b>`);
        }
      }
    } else if (totalQtyToOrder > 0) {
      const orderDate = new Date();
      orderDate.setDate(orderDate.getDate() + Math.max(0, daysUntilOrder));
      const dateStr = orderDate.toLocaleDateString("ru", { day: "numeric", month: "short" });
      lines.push(`  📋 Следующая поставка: <b>${dateStr}</b> · ${totalQtyToOrder} шт`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

function formatStocksMessage(snapshot, kpi) {
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
    lines.push(formatChannelStocksBlock(channel, label, emoji, kpi));
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

function formatWeeklyMessage(snapshotNow, snapshotPrev, kpi) {
  // snapshotNow = текущая неделя, snapshotPrev = прошлая неделя
  const channels = snapshotNow.channels || [];
  const channelsPrev = snapshotPrev ? (snapshotPrev.channels || []) : [];

  function delta(now, prev) {
    if (!prev || prev === 0) return null;
    return ((now - prev) / prev * 100);
  }
  function fmtDelta(d) {
    if (d === null) return "";
    const sign = d >= 0 ? "▲" : "▼";
    return ` ${sign} ${Math.abs(d).toFixed(1)}% к прошлой неделе`;
  }

  const now = dayjs();
  const weekStart = now.subtract(7, 'day').format("DD.MM");
  const weekEnd   = now.format("DD.MM");

  const lines = [
    `📅 <b>Еженедельный отчёт</b>`,
    `${weekStart} — ${weekEnd}`,
    "",
  ];

  for (let i = 0; i < channels.length; i++) {
    const ch     = channels[i];
    const chPrev = channelsPrev[i] || null;
    const isOzon = i === 0;
    const emoji  = isOzon ? "🔵" : "🟣";
    const label  = isOzon ? "Ozon" : "Wildberries";

    if (ch.source !== "api" && channelsPrev.some(c => c.source === "api")) continue;

    const m     = ch.month     || {};
    const mPrev = chPrev ? (chPrev.month || {}) : {};

    const revDelta  = delta(m.revenue,  mPrev.revenue);
    const ordDelta  = delta(m.orders,   mPrev.orders);
    const adDelta   = delta(m.adSpend,  mPrev.adSpend);
    const drrNow    = m.revenue  ? (m.adSpend  / m.revenue  * 100) : 0;
    const drrPrev   = mPrev.revenue ? (mPrev.adSpend / mPrev.revenue * 100) : null;
    const drrDelta  = drrPrev !== null ? (drrNow - drrPrev) : null;
    const drrStatus = drrNow <= 10 ? "🟢" : drrNow <= 20 ? "🟡" : "🔴";

    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`${emoji} <b>${label}</b>`);
    lines.push("");
    lines.push(`💰 Выручка: <b>${formatCompactMoney(m.revenue)}</b>${fmtDelta(revDelta)}`);
    lines.push(`📦 Заказы: <b>${Math.round(m.orders || 0)}</b>${fmtDelta(ordDelta)}`);
    lines.push(`📢 Реклама: <b>${formatCompactMoney(m.adSpend)}</b>${fmtDelta(adDelta)}`);
    lines.push(`📊 ДРР: <b>${drrNow.toFixed(1)}%</b> ${drrStatus}${drrDelta !== null ? ` (${drrDelta >= 0 ? "+" : ""}${drrDelta.toFixed(1)} п.п.)` : ""}`);
    lines.push("");
  }

  lines.push(`━━━━━━━━━━━━━━━━━━`);

  // Товары требующие внимания
  const atRisk = snapshotNow.atRiskProducts.filter(p => p.trend === "down").slice(0, 2);
  if (atRisk.length > 0) {
    lines.push("");
    lines.push("🚨 <b>Требуют внимания на этой неделе:</b>");
    for (const p of atRisk) {
      lines.push(`• <b>${p.name}</b> — ${p.reason}`);
    }
  }

  return lines.join("\n");
}

module.exports = {
  formatHeroMessage,
  formatStatsMessage,
  formatMonthMessage,
  formatStocksMessage,
  formatWeeklyMessage,
  formatSettingsMessage,
  formatMoney,
};
