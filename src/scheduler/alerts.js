const dayjs = require("dayjs");

// Антиспам — хранит время последней отправки по коду алерта
const alertCooldowns = {};

function canSend(code, cooldownMs) {
  const last = alertCooldowns[code] || 0;
  if (Date.now() - last > cooldownMs) {
    alertCooldowns[code] = Date.now();
    return true;
  }
  return false;
}

function calcDrr(adSpend, revenue) {
  if (!revenue || revenue === 0) return 0;
  return (adSpend / revenue) * 100;
}

// ── Аномалии заказов ─────────────────────────────────────────────────
// Умный порог зависит от среднего объёма — не спамит на малых объёмах
function getAnomalyThreshold(avgDaily) {
  if(avgDaily < 3)  return 5.0; // 1-2 шт/день → сигнал только при ×5
  if(avgDaily < 10) return 3.0; // 3-9 шт/день → сигнал при ×3
  if(avgDaily < 30) return 2.5; // 10-29 шт/день → сигнал при ×2.5
  return 2.0;                   // 30+ шт/день → сигнал при ×2
}

function detectOrderAnomalies(snapshot) {
  const anomalies = [];
  const channels = snapshot.channels || [];

  for (const channel of channels) {
    const label = channel.platform === "ozon" ? "Ozon" : "Wildberries";
    const stocks = channel.stocks || [];
    const todayOrders = channel.today?.orders || 0;

    for (const s of stocks) {
      const avgDaily = s.daysCover > 0 ? s.qty / s.daysCover : 0;
      if (avgDaily <= 0) continue;

      const sToday = s.todayOrders != null
        ? s.todayOrders
        : Math.round(todayOrders / Math.max(stocks.length, 1));
      if (sToday <= 0) continue;

      const ratio = sToday / avgDaily;
      const threshold = getAnomalyThreshold(avgDaily);
      if (ratio < threshold) continue;

      const hasAd = (s.monthAdSpend || 0) > 0;
      anomalies.push({
        label,
        name: s.name,
        sku: s.sku,
        avgDaily: Math.round(avgDaily * 10) / 10,
        todayOrders: sToday,
        qty: s.qty || 0,
        ratio,
        hasAd, // есть ли активная реклама
      });
    }
  }

  return anomalies;
}

function buildAlerts(snapshot, kpi) {
  const alerts = [];
  const now = dayjs();
  const daysInMonth      = now.daysInMonth();
  const elapsedDays      = now.date();
  const conversionPlan   = Number(kpi.conversion      || 0);
  const adBudgetPlan     = Number(kpi.ad_budget       || 0);
  const monthRevenuePlan = Number(kpi.revenue         || 0);
  const dayOrdersPlan    = Number(kpi.daily_orders    || 0);
  const drrThreshold     = Number(kpi.drr_threshold   || 20);
  const SUPPLY_DAYS      = (kpi.supply_days && kpi.supply_days > 0) ? Number(kpi.supply_days) : 14;

  const channels = snapshot.channels || [];

  // ── 🚨 Аномалии заказов (кулдаун 2ч на артикул) ─────────────────
  const anomalies = detectOrderAnomalies(snapshot, 2.0);
  for (const a of anomalies) {
    const code = `order_anomaly_${a.label.toLowerCase()}_${(a.sku || a.name).replace(/\s+/g, "_")}`;
    if (!canSend(code, 2 * 60 * 60 * 1000)) continue;

    const lvl = a.ratio >= 3 && !a.hasAd ? "🔴 КРИТИЧНО" : a.hasAd ? "🟡 Проверить" : "🟠 Подозрительно";
    const adNote = a.hasAd
      ? `📢 На артикул запущена реклама — возможен органический эффект`
      : `⚠️ Реклама не запущена — рост без объяснимой причины`;
    const recommendation = a.hasAd
      ? `Проверьте CTR и конверсию кампании — если в норме, это органика`
      : `Временно скройте товар или поднимите цену на 20–30%`;

    alerts.push({
      code,
      urgent: !a.hasAd, // если реклама есть — не срочный, просто проверить
      message:
        `🚨 <b>Аномалия заказов — ${a.label}</b>\n\n` +
        `${lvl}\n` +
        `<b>${a.name}</b>${a.sku ? ` <code>${a.sku}</code>` : ""}\n\n` +
        `Обычно: ~<b>${a.avgDaily} шт/день</b>\n` +
        `Сегодня: <b>${a.todayOrders} шт</b> (×${a.ratio.toFixed(1)})\n` +
        `На складе: <b>${a.qty.toLocaleString("ru")} шт</b>\n\n` +
        `${adNote}\n\n` +
        `💡 <b>Что делать:</b> ${recommendation}`,
    });
  }

  // ── ДРР — резкий перерасход (внеплановое, кулдаун 4ч) ───────────
  for (const channel of channels) {
    const t = channel.today || {};
    if (!t.revenue || !t.adSpend) continue;
    const drr   = calcDrr(t.adSpend, t.revenue);
    const label = channel.platform === "ozon" ? "Ozon" : "Wildberries";

    const spikeCode = `drr_spike_${label.toLowerCase()}`;
    if (drr > drrThreshold * 1.3 && canSend(spikeCode, 4 * 60 * 60 * 1000)) {
      alerts.push({
        code: spikeCode,
        urgent: true,
        message:
          `🔴 <b>⚡ Перерасход рекламы — ${label}</b>\n` +
          `ДРР: <b>${drr.toFixed(1)}%</b> (порог ${drrThreshold}%)\n` +
          `Реклама: ${Math.round(t.adSpend).toLocaleString("ru")} ₽ / Выручка: ${Math.round(t.revenue).toLocaleString("ru")} ₽\n` +
          `Проверьте ставки и отключите убыточные кампании`,
      });
    }

    if (drr > drrThreshold && !alerts.find(a => a.code === spikeCode)) {
      alerts.push({
        code: `drr_high_${label.toLowerCase()}`,
        urgent: false,
        message:
          `🔴 <b>ДРР превышает норму — ${label}</b>\n` +
          `Факт: <b>${drr.toFixed(1)}%</b>, порог: <b>${drrThreshold}%</b>\n` +
          `Реклама съедает слишком большую долю выручки`,
      });
    }
  }

  // ── Выкуп% критично низкий (кулдаун 12ч) ─────────────────────────
  for (const channel of channels) {
    const label      = channel.platform === "ozon" ? "Ozon" : "Wildberries";
    const threshold  = label === "Ozon" ? 90 : 80;
    const redemption = channel.redemption;
    if (!redemption || redemption.avg === null || redemption.avg === undefined) continue;
    const code = `redemption_low_${label.toLowerCase()}`;
    if (redemption.avg < threshold - 10 && canSend(code, 12 * 60 * 60 * 1000)) {
      const bad = (redemption.bad || []).slice(0, 3).map(s => `• ${s.name} — ${s.rate}%`).join("\n");
      alerts.push({
        code,
        urgent: false,
        message:
          `🛍️ <b>Выкуп ниже нормы — ${label}</b>\n` +
          `Средний: <b>${redemption.avg}%</b> (норма ≥${threshold}%)\n` +
          (bad ? `Проблемные артикулы:\n${bad}\n` : "") +
          `Проверьте размерную сетку, фото и описание`,
      });
    }
  }

  // ── Платное хранение (кулдаун 24ч) ──────────────────────────────
  for (const channel of channels) {
    const label     = channel.platform === "ozon" ? "Ozon" : "Wildberries";
    const PAID_DAYS = label === "Ozon" ? 61 : 60;
    const atRisk    = (channel.stocks || []).filter(s => s.daysCover > PAID_DAYS);
    const code      = `paid_storage_${label.toLowerCase()}`;
    if (atRisk.length > 0 && canSend(code, 24 * 60 * 60 * 1000)) {
      const names = atRisk.slice(0, 3).map(s => `• ${s.name} — ${s.daysCover} дн`).join("\n");
      alerts.push({
        code,
        urgent: false,
        message:
          `🔄 <b>Платное хранение — ${label}</b>\n` +
          `${atRisk.length} ${atRisk.length === 1 ? "товар" : "товара"} свыше ${PAID_DAYS} дней:\n` +
          `${names}\n` +
          `Маркетплейс списывает деньги ежедневно — запустите акцию или снимите с продажи`,
      });
    }
  }

  // ── Критичный остаток (кулдаун 6ч) ──────────────────────────────
  const urgentStocks = snapshot.stocks.filter(s => s.daysCover < SUPPLY_DAYS);
  if (urgentStocks.length > 0 && canSend("supply_urgent", 6 * 60 * 60 * 1000)) {
    const names = urgentStocks.slice(0, 3).map(s => s.name).join(", ");
    alerts.push({
      code: "supply_urgent",
      urgent: true,
      message:
        `🚛 <b>Срочно везти на склад!</b>\n` +
        `Товары заканчиваются (менее ${SUPPLY_DAYS} дней):\n` +
        `<b>${names}</b>\n` +
        `Нужно организовать поставку немедленно`,
    });
  }

  // ── Товар в зоне риска (кулдаун 6ч, не более 2 раз/день) ────────
  const riskProducts = (snapshot.atRiskProducts || []).filter(p => p.trend === "down");
  if (riskProducts.length > 0) {
    const todayKey   = `product_at_risk_count_${dayjs().format("YYYY-MM-DD")}`;
    const todayCount = alertCooldowns[todayKey] || 0;
    if (todayCount < 2 && canSend("product_at_risk_urgent", 6 * 60 * 60 * 1000)) {
      alertCooldowns[todayKey] = todayCount + 1;
      const p = riskProducts[0];
      const parts = [];
      if (p.revenueDelta !== undefined) parts.push(`Выручка: ${p.revenueDelta >= 0 ? "▲" : "▼"}${Math.abs(p.revenueDelta)}%`);
      if (p.ordersDelta  !== undefined) parts.push(`Заказы: ${p.ordersDelta >= 0 ? "▲" : "▼"}${Math.abs(p.ordersDelta)}%`);
      if (p.ctrDelta     !== undefined) parts.push(`CTR: ${p.ctrDelta >= 0 ? "▲" : "▼"}${Math.abs(p.ctrDelta)}%`);
      alerts.push({
        code: "product_at_risk_urgent",
        urgent: true,
        message:
          `🚨 <b>Критичные показатели — товар в зоне риска</b>\n` +
          `<b>${p.name}</b>${p.sku ? ` (${p.sku})` : ""}\n` +
          `${p.reason}\n` +
          (parts.length ? `<i>${parts.join("  ")}</i>` : ""),
      });
    }
  }

  // ── Конверсия ниже порога ─────────────────────────────────────────
  if (conversionPlan > 0 && snapshot.today.conversion < conversionPlan * 0.7) {
    alerts.push({
      code: "conversion_low",
      urgent: false,
      message:
        `🔔 <b>Конверсия ниже порога</b>\n` +
        `Факт: <b>${snapshot.today.conversion.toFixed(2)}%</b>, ` +
        `порог: <b>${(conversionPlan * 0.7).toFixed(2)}%</b>`,
    });
  }

  // ── Рекламный бюджет почти исчерпан ──────────────────────────────
  if (adBudgetPlan > 0 && snapshot.month.adSpend >= adBudgetPlan * 0.85) {
    alerts.push({
      code: "ad_budget_high",
      urgent: false,
      message:
        `⚠️ <b>Рекламный бюджет почти исчерпан</b>\n` +
        `Израсходовано: <b>${Math.round((snapshot.month.adSpend / adBudgetPlan) * 100)}%</b>`,
    });
  }

  // ── Выручка отстаёт от плана ──────────────────────────────────────
  if (monthRevenuePlan > 0) {
    const expected = (monthRevenuePlan / daysInMonth) * elapsedDays;
    if (snapshot.month.revenue < expected * 0.6) {
      alerts.push({
        code: "month_revenue_lagging",
        urgent: false,
        message:
          `📉 <b>Выручка отстаёт от плана</b>\n` +
          `Факт: <b>${Math.round(snapshot.month.revenue).toLocaleString("ru-RU")} ₽</b>\n` +
          `Ожидалось к дате: <b>${Math.round(expected).toLocaleString("ru-RU")} ₽</b>`,
      });
    }
  }

  // ── Заказов значительно меньше плана ─────────────────────────────
  if (dayOrdersPlan > 0 && snapshot.today.orders < dayOrdersPlan * 0.4) {
    alerts.push({
      code: "orders_low",
      urgent: false,
      message:
        `📦 <b>Заказов значительно меньше плана</b>\n` +
        `Факт: <b>${Math.round(snapshot.today.orders)}</b>, план: <b>${dayOrdersPlan}</b>`,
    });
  }

  // ── Негативные отзывы ─────────────────────────────────────────────
  const badReviews = snapshot.badReviews || [];
  if (badReviews.length > 0) {
    const review = badReviews[0];
    alerts.push({
      code: "bad_review",
      urgent: false,
      message:
        `⭐ <b>Новый негативный отзыв</b>\n` +
        `Товар: <b>${review.productName}</b>\n` +
        `Оценка: ${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)} (${review.rating}/5)\n` +
        `"${review.text ? review.text.slice(0, 120) : "без текста"}"`,
    });
  }

  // ── Падение выручки vs прошлая неделя ────────────────────────────
  if (snapshot.weekRevenueDelta !== undefined && snapshot.weekRevenueDelta < -15) {
    alerts.push({
      code: "week_revenue_drop",
      urgent: false,
      message:
        `📉 <b>Выручка падает по сравнению с прошлой неделей</b>\n` +
        `Снижение: <b>${Math.abs(snapshot.weekRevenueDelta).toFixed(1)}%</b>\n` +
        `Проверьте рекламу и наличие товара на складах`,
    });
  }

  return alerts;
}

function buildUrgentAlerts(snapshot, kpi) {
  return buildAlerts(snapshot, kpi).filter(a => a.urgent);
}

module.exports = { buildAlerts, buildUrgentAlerts, detectOrderAnomalies };
