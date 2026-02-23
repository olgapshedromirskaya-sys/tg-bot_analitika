const dayjs = require("dayjs");

function formatCompactMoney(value) {
  const abs = Math.abs(Number(value || 0));
  if (abs >= 1_000_000) return `₽${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `₽${(value / 1_000).toFixed(0)}K`;
  return `₽${Math.round(value)}`;
}

function formatMoney(value) {
  return `₽${Math.round(Number(value || 0)).toLocaleString("ru-RU")}`;
}

function formatSigned(value, digits = 0) {
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
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
    revenue:   Number(kpi.revenue      || 0),
    adBudget:  Number(kpi.ad_budget    || 0),
    orders:    Number(kpi.daily_orders || 0) * daysInMonth,
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

  // CPO общий
  const cpo = (t.orders && t.adSpend) ? Math.round(t.adSpend / t.orders) : null;
  const cpoStatus = !cpo ? "" : cpo < 300 ? " 🟢" : cpo < 800 ? " 🟡" : " 🔴";

  const lines = [
    `${emoji} <b>${label}</b> · ${channel.source === "api" ? "реальные данные" : "демо"}`,
    `💰 Выручка: <b>${formatCompactMoney(t.revenue)}</b>`,
    `📦 Заказы: <b>${Math.round(t.orders || 0)}</b>`,
    `📢 Реклама: <b>${formatCompactMoney(t.adSpend)}</b>`,
    `📊 ДРР: <b>${drr.toFixed(1)}%</b>${drrStatus}`,
    `🔄 Конверсия: <b>${Number(t.conversion || 0).toFixed(1)}%</b>`,
  ];

  if (cpo) lines.push(`🎯 CPO: <b>${formatCompactMoney(cpo)}</b>${cpoStatus}`);

  // Выкуп%
  const redemption = channel.redemption;
  if (redemption && redemption.avg !== null && redemption.avg !== undefined) {
    const threshold = label === "Ozon" ? 90 : 80;
    const rStatus = redemption.avg >= threshold ? "🟢" : redemption.avg >= threshold - 10 ? "🟡" : "🔴";
    lines.push(`🛍️ Выкуп: <b>${redemption.avg}%</b> ${rStatus}`);
  }

  const risk = (channel.atRiskProducts || []).filter(p => p.trend === "down")[0];
  if (risk) lines.push(`🚨 Риск: <b>${risk.name}</b> — ${risk.reason}`);

  const growth = (channel.atRiskProducts || []).filter(p => p.trend === "up")[0];
  if (growth) lines.push(`📈 Рост: <b>${growth.name}</b> — ${growth.reason}`);

  return lines.join("\n");
}

function formatStatsMessage(snapshot, kpi) {
  const channels = snapshot.channels || [];
  const ozon = channels[0];
  const wb   = channels[1];

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
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push(formatChannelBlock(channel, isOzon ? "Ozon" : "Wildberries", isOzon ? "🔵" : "🟣"));
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

// ── ДРР детальный отчёт с разбивкой по артикулам ───────────────────
// ДРР по артикулу = monthAdSpend / (monthOrders * avgPrice) — приближение
// Точнее: если есть monthAdSpend и monthOrders → показываем CPO и долю рекламы
// Сортируем по ДРР убывая — самые дорогие артикулы сверху
function formatDrrMessage(snapshot) {
  const channels = snapshot.channels || [];
  const hasAnyApi = channels.some(c => c.source === "api");
  const visible = hasAnyApi ? channels.filter(c => c.source === "api") : channels;
  const ozon = channels[0];

  const lines = [
    "📊 <b>ДРР — доля рекламных расходов</b>",
    `${dayjs().format("DD.MM.YYYY")}`,
    "",
  ];

  for (const channel of visible) {
    const isOzon = channel === ozon;
    const label  = isOzon ? "Ozon" : "Wildberries";
    const emoji  = isOzon ? "🔵" : "🟣";
    const t = channel.today || {};
    const m = channel.month || {};

    // Общий ДРР
    const drrToday = calcDrr(t.adSpend, t.revenue);
    const drrMonth = calcDrr(m.adSpend, m.revenue);
    const statusT  = drrToday <= 10 ? "🟢" : drrToday <= 20 ? "🟡" : "🔴";
    const statusM  = drrMonth <= 10 ? "🟢" : drrMonth <= 20 ? "🟡" : "🔴";

    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`${emoji} <b>${label}</b>`);
    lines.push(`Сегодня: <b>${drrToday.toFixed(1)}%</b> ${statusT}  |  Месяц: <b>${drrMonth.toFixed(1)}%</b> ${statusM}`);
    lines.push(`Норма: 🟢 до 10%  🟡 10–20%  🔴 выше 20%`);
    lines.push("");

    // ДРР по артикулам
    // monthAdSpend — расходы на рекламу по артикулу за месяц
    // monthOrders  — заказы по артикулу за месяц
    // Выручку по артикулу считаем как: общая выручка / общие заказы * заказы артикула
    const stocks = (channel.stocks || []).filter(s => s.monthAdSpend > 0 && s.monthOrders > 0);

    if (stocks.length > 0) {
      // Средняя цена = выручка за месяц / заказы за месяц
      const avgPrice = (m.orders > 0 && m.revenue > 0) ? m.revenue / m.orders : 0;

      // Считаем ДРР по артикулу
      const skuRows = stocks.map(s => {
        const skuRevenue = avgPrice > 0 ? avgPrice * s.monthOrders : 0;
        const drr = skuRevenue > 0 ? (s.monthAdSpend / skuRevenue * 100) : 0;
        const cpo = Math.round(s.monthAdSpend / s.monthOrders);
        return { ...s, drr, cpo, skuRevenue };
      }).sort((a, b) => b.drr - a.drr); // худшие сверху

      lines.push(`📋 <b>По артикулам (за месяц):</b>`);
      lines.push(`<i>Норма ДРР ≤10%  ·  &lt;300₽ CPO — хорошо  ·  &gt;800₽ — дорого</i>`);
      lines.push("");

      for (const s of skuRows.slice(0, 10)) {
        const drrIcon = s.drr <= 10 ? "🟢" : s.drr <= 20 ? "🟡" : "🔴";
        const cpoIcon = s.cpo < 300 ? "🟢" : s.cpo < 800 ? "🟡" : "🔴";
        const drrStr  = s.drr > 0 ? `ДРР ${s.drr.toFixed(1)}% ${drrIcon}` : "ДРР н/д";
        const cpoStr  = `CPO ${formatCompactMoney(s.cpo)} ${cpoIcon}`;
        lines.push(`<b>${s.name}</b> <i>(${s.sku})</i>`);
        lines.push(`  ${drrStr}  ·  ${cpoStr}  ·  реклама ${formatCompactMoney(s.monthAdSpend)} / ${s.monthOrders} зак`);
      }

      // Артикулы без рекламы
      const noAd = (channel.stocks || []).filter(s => !s.monthAdSpend || s.monthAdSpend === 0);
      if (noAd.length > 0) {
        lines.push("");
        lines.push(`⚪ Без рекламы (${noAd.length} арт.): ${noAd.slice(0, 3).map(s => s.name).join(", ")}${noAd.length > 3 ? "..." : ""}`);
      }
    } else {
      lines.push(`Данные по артикулам недоступны — нет рекламных расходов по SKU`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

// ── Выкуп% отчёт ────────────────────────────────────────────────────
function formatRedemptionMessage(snapshot) {
  const channels = snapshot.channels || [];
  const hasAnyApi = channels.some(c => c.source === "api");
  const visible = hasAnyApi ? channels.filter(c => c.source === "api") : channels;
  const ozon = channels[0];

  const lines = [
    "🛍️ <b>Выкуп товаров</b>",
    `${dayjs().format("DD.MM.YYYY")}`,
    "",
  ];

  for (const channel of visible) {
    const isOzon = channel === ozon;
    const label     = isOzon ? "Ozon" : "Wildberries";
    const emoji     = isOzon ? "🔵" : "🟣";
    const threshold = isOzon ? 90 : 80;
    const redemption = channel.redemption;

    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`${emoji} <b>${label}</b>`);

    if (!redemption || redemption.avg === null || redemption.avg === undefined) {
      lines.push(`Данные недоступны`);
      lines.push("");
      continue;
    }

    const avgStatus = redemption.avg >= threshold ? "🟢" : redemption.avg >= threshold - 10 ? "🟡" : "🔴";
    lines.push(`Средний выкуп: <b>${redemption.avg}%</b> ${avgStatus} (норма ≥${threshold}%)`);

    const bad = (redemption.bad || []);
    if (bad.length === 0) {
      lines.push(`✅ Все артикулы в норме`);
    } else {
      lines.push(`⚠️ Проблемные артикулы (выкуп &lt;${threshold}%):`);
      for (const s of bad.slice(0, 5)) {
        const st = s.rate >= threshold - 10 ? "🟡" : "🔴";
        lines.push(`  ${st} <b>${s.name}</b> — ${s.rate}% (${s.sales}/${s.orders})`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ── Оборачиваемость отчёт ───────────────────────────────────────────
function formatTurnoverMessage(snapshot) {
  const channels = snapshot.channels || [];
  const hasAnyApi = channels.some(c => c.source === "api");
  const visible = hasAnyApi ? channels.filter(c => c.source === "api") : channels;
  const ozon = channels[0];

  const lines = [
    "🔄 <b>Оборачиваемость товаров</b>",
    `${dayjs().format("DD.MM.YYYY")}`,
    "",
  ];

  for (const channel of visible) {
    const isOzon   = channel === ozon;
    const label    = isOzon ? "Ozon" : "Wildberries";
    const emoji    = isOzon ? "🔵" : "🟣";
    const PAID_DAYS = isOzon ? 61 : 60;
    const stocks   = (channel.stocks || []).filter(s => s.daysCover > 0);

    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`${emoji} <b>${label}</b>`);

    if (!stocks.length) {
      lines.push(`Данные недоступны`);
      lines.push("");
      continue;
    }

    const avg = Math.round(stocks.reduce((s, i) => s + i.daysCover, 0) / stocks.length);
    const atRisk = stocks.filter(s => s.daysCover > PAID_DAYS);
    const avgStatus = avg <= 30 ? "🟢" : avg <= PAID_DAYS ? "🟡" : "🔴";

    lines.push(`Средняя оборачиваемость: <b>${avg} дней</b> ${avgStatus}`);
    lines.push(`Норма: 🟢 до 30 дн  🟡 30–${PAID_DAYS} дн  🔴 &gt;${PAID_DAYS} дн (платное хранение)`);

    if (atRisk.length > 0) {
      lines.push(`🚨 На платном хранении (${atRisk.length} шт):`);
      for (const s of atRisk.slice(0, 5)) {
        lines.push(`  🔴 <b>${s.name}</b> — ${s.daysCover} дн`);
      }
    }

    // Медленные (30..PAID_DAYS)
    const slow = stocks.filter(s => s.daysCover > 30 && s.daysCover <= PAID_DAYS);
    if (slow.length > 0 && atRisk.length === 0) {
      lines.push(`🟡 Медленные товары (${slow.length} шт):`);
      for (const s of slow.slice(0, 3)) {
        lines.push(`  🟡 <b>${s.name}</b> — ${s.daysCover} дн`);
      }
    }

    if (atRisk.length === 0 && slow.length === 0) {
      lines.push(`✅ Все товары в норме оборачиваемости`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

// ── Товары в зоне риска ─────────────────────────────────────────────
function formatRiskMessage(snapshot) {
  const channels = snapshot.channels || [];
  const hasAnyApi = channels.some(c => c.source === "api");
  const visible = hasAnyApi ? channels.filter(c => c.source === "api") : channels;
  const ozon = channels[0];

  const lines = [
    "🚨 <b>Товары в зоне риска</b>",
    `${dayjs().format("DD.MM.YYYY")}`,
    "",
  ];

  let hasAny = false;

  for (const channel of visible) {
    const isOzon = channel === ozon;
    const label  = isOzon ? "Ozon" : "Wildberries";
    const emoji  = isOzon ? "🔵" : "🟣";

    const risks   = (channel.atRiskProducts || []).filter(p => p.trend === "down" || !p.trend);
    const growths = (channel.atRiskProducts || []).filter(p => p.trend === "up");

    if (!risks.length && !growths.length) continue;
    hasAny = true;

    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`${emoji} <b>${label}</b>`);
    lines.push("");

    for (const p of risks.slice(0, 5)) {
      lines.push(`🚨 <b>${p.name}</b>${p.sku ? ` (${p.sku})` : ""}`);
      lines.push(`   ${p.reason}`);
      const parts = [];
      if (p.revenueDelta !== undefined) parts.push(`Выручка ${p.revenueDelta >= 0 ? "▲" : "▼"}${Math.abs(p.revenueDelta)}%`);
      if (p.ordersDelta  !== undefined) parts.push(`Заказы ${p.ordersDelta >= 0 ? "▲" : "▼"}${Math.abs(p.ordersDelta)}%`);
      if (p.ctrDelta     !== undefined) parts.push(`CTR ${p.ctrDelta >= 0 ? "▲" : "▼"}${Math.abs(p.ctrDelta)}%`);
      if (parts.length) lines.push(`   <i>${parts.join("  ")}</i>`);
      lines.push("");
    }

    for (const p of growths.slice(0, 3)) {
      lines.push(`📈 <b>${p.name}</b>${p.sku ? ` (${p.sku})` : ""}`);
      lines.push(`   ${p.reason}`);
      lines.push("");
    }
  }

  if (!hasAny) lines.push("✅ Товаров в зоне риска нет");

  return lines.join("\n").trim();
}

function formatChannelMonthBlock(channel, label, emoji, kpi) {
  const plans = getMonthPlans(kpi);
  const m = channel.month || {};
  const revenueLine = `${formatMoney(m.revenue)} / ${formatMoney(plans.revenue)}`;
  const adLine      = `${formatMoney(m.adSpend)} / ${formatMoney(plans.adBudget)}`;
  const ordersLine  = `${Math.round(m.orders || 0).toLocaleString("ru-RU")} / ${Math.round(plans.orders).toLocaleString("ru-RU")}`;
  const drrMonth = calcDrr(m.adSpend, m.revenue);
  const drrMonthStatus = drrMonth === 0 ? "" : drrMonth <= 10 ? " 🟢" : drrMonth <= 20 ? " 🟡" : " 🔴";

  // Выкуп за месяц
  const redemption = channel.redemption;
  const isOzon = label === "Ozon";
  const threshold = isOzon ? 90 : 80;
  const redemptionLine = (redemption && redemption.avg !== null && redemption.avg !== undefined)
    ? `\n🛍️ Выкуп: <b>${redemption.avg}%</b>${redemption.avg >= threshold ? " 🟢" : redemption.avg >= threshold - 10 ? " 🟡" : " 🔴"}`
    : "";

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
    `📊 ДРР за месяц: <b>${drrMonth.toFixed(1)}%</b>${drrMonthStatus} <i>(норма до 10%)</i>${redemptionLine}`,
  ].join("\n");
}

function formatMonthMessage(snapshot, kpi) {
  const channels = snapshot.channels || [];
  const ozon = channels[0];
  const hasAnyApi = channels.some(c => c.source === "api");
  const visibleChannels = hasAnyApi ? channels.filter(c => c.source === "api") : channels;

  const lines = [
    "📈 <b>Месячный отчёт</b>",
    `${dayjs().format("DD.MM.YYYY")}`,
    "",
  ];

  for (const channel of visibleChannels) {
    const isOzon = channel === ozon;
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push(formatChannelMonthBlock(channel, isOzon ? "Ozon" : "Wildberries", isOzon ? "🔵" : "🟣", kpi));
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

function calcWarehouseSupply(warehouses, totalQtyToOrder) {
  if (!warehouses || !warehouses.length || totalQtyToOrder <= 0) return [];
  const totalSales = warehouses.reduce((s, w) => s + (w.qty || 0), 0) || 1;
  return warehouses
    .map(w => ({ name: w.name, qty: Math.round(totalQtyToOrder * (w.qty || 0) / totalSales) }))
    .filter(w => w.qty > 0);
}

function formatChannelStocksBlock(channel, label, emoji, kpi) {
  const stocks = (channel.stocks || []).slice(0, 5);
  if (!stocks.length) return `${emoji} <b>${label}</b>\nДанные по остаткам недоступны.`;

  const SUPPLY_DAYS = (kpi && kpi.supply_days > 0) ? Number(kpi.supply_days) : 14;
  const TARGET_DAYS = 30;
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
      lines.push(`  🚨 <b>Поставка срочно!</b> Догрузить: ${totalQtyToOrder} шт`);
      const whs = calcWarehouseSupply(channelWarehouses, totalQtyToOrder);
      if (whs.length > 0) {
        for (const wh of whs) lines.push(`    📦 На <b>${wh.name}</b>: <b>${wh.qty} шт</b>`);
      } else {
        lines.push(`    📦 На <b>${item.warehouseName || "склад"}</b>: <b>${totalQtyToOrder} шт</b>`);
      }
    } else if (item.daysCover < SUPPLY_DAYS + 7) {
      const orderDate = new Date();
      orderDate.setDate(orderDate.getDate() + Math.max(0, daysUntilOrder));
      const dateStr = orderDate.toLocaleDateString("ru", { day: "numeric", month: "short" });
      lines.push(`  ⚡ <b>Поставка:</b> отгрузить <b>${dateStr}</b> · Догрузить: ${totalQtyToOrder} шт`);
      const whs = calcWarehouseSupply(channelWarehouses, totalQtyToOrder);
      if (whs.length > 0) {
        for (const wh of whs) lines.push(`    📦 На <b>${wh.name}</b>: <b>${wh.qty} шт</b>`);
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
  const hasAnyApi = channels.some(c => c.source === "api");
  const visibleChannels = hasAnyApi ? channels.filter(c => c.source === "api") : channels;

  const lines = [
    "📦 <b>Остатки на складах</b>",
    `${dayjs().format("DD.MM.YYYY")}`,
    "",
  ];

  for (const channel of visibleChannels) {
    const isOzon = channel === ozon;
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push(formatChannelStocksBlock(channel, isOzon ? "Ozon" : "Wildberries", isOzon ? "🔵" : "🟣", kpi));
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
  const weekStart = now.subtract(7, "day").format("DD.MM");
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

    const revDelta = delta(m.revenue, mPrev.revenue);
    const ordDelta = delta(m.orders,  mPrev.orders);
    const adDelta  = delta(m.adSpend, mPrev.adSpend);
    const drrNow   = m.revenue  ? (m.adSpend / m.revenue * 100) : 0;
    const drrPrev  = mPrev.revenue ? (mPrev.adSpend / mPrev.revenue * 100) : null;
    const drrDelta = drrPrev !== null ? (drrNow - drrPrev) : null;
    const drrStatus = drrNow <= 10 ? "🟢" : drrNow <= 20 ? "🟡" : "🔴";

    // CPO недельный
    const cpo = (m.orders && m.adSpend) ? Math.round(m.adSpend / m.orders) : null;
    const cpoStatus = !cpo ? "" : cpo < 300 ? " 🟢" : cpo < 800 ? " 🟡" : " 🔴";

    // Выкуп
    const threshold = isOzon ? 90 : 80;
    const redemption = ch.redemption;
    const rAvg = redemption?.avg;
    const rStatus = rAvg === undefined || rAvg === null ? "" : rAvg >= threshold ? " 🟢" : rAvg >= threshold - 10 ? " 🟡" : " 🔴";

    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`${emoji} <b>${label}</b>`);
    lines.push("");
    lines.push(`💰 Выручка: <b>${formatCompactMoney(m.revenue)}</b>${fmtDelta(revDelta)}`);
    lines.push(`📦 Заказы: <b>${Math.round(m.orders || 0)}</b>${fmtDelta(ordDelta)}`);
    lines.push(`📢 Реклама: <b>${formatCompactMoney(m.adSpend)}</b>${fmtDelta(adDelta)}`);
    lines.push(`📊 ДРР: <b>${drrNow.toFixed(1)}%</b> ${drrStatus}${drrDelta !== null ? ` (${drrDelta >= 0 ? "+" : ""}${drrDelta.toFixed(1)} п.п.)` : ""}`);
    if (cpo) lines.push(`🎯 CPO: <b>${formatCompactMoney(cpo)}</b>${cpoStatus}`);
    if (rAvg !== undefined && rAvg !== null) lines.push(`🛍️ Выкуп: <b>${rAvg}%</b>${rStatus}`);
    lines.push("");
  }

  lines.push(`━━━━━━━━━━━━━━━━━━`);

  const atRisk = snapshotNow.atRiskProducts.filter(p => p.trend === "down").slice(0, 2);
  if (atRisk.length > 0) {
    lines.push("");
    lines.push("🚨 <b>Требуют внимания на этой неделе:</b>");
    for (const p of atRisk) lines.push(`• <b>${p.name}</b> — ${p.reason}`);
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
  formatDrrMessage,
  formatRedemptionMessage,
  formatTurnoverMessage,
  formatRiskMessage,
  formatMoney,
};
