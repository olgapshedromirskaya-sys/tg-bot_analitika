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
  const drrThreshold = Number(kpi.drr_threshold || 20); // порог ДРР, по умолчанию 20%

  // ── ДРР превышает порог ──────────────────────────────────────────
  const channels = snapshot.channels || [];
  for (const channel of channels) {
    const t = channel.today || {};
    if (t.revenue && t.adSpend) {
      const drr = (t.adSpend / t.revenue) * 100;
      if (drr > drrThreshold) {
        const label = channels.indexOf(channel) === 0 ? "Ozon" : "Wildberries";
        alerts.push({
          code: `drr_high_${label.toLowerCase()}`,
          message:
            `🔴 <b>ДРР превышает норму — ${label}</b>\n` +
            `Факт: <b>${drr.toFixed(1)}%</b>, порог: <b>${drrThreshold}%</b>\n` +
            `Реклама съедает слишком большую долю выручки`,
        });
      }
    }
  }

  // ── Конверсия ниже порога ────────────────────────────────────────
  if (conversionPlan > 0 && snapshot.today.conversion < conversionPlan * 0.7) {
    alerts.push({
      code: "conversion_low",
      message:
        `🔔 <b>Конверсия ниже порога</b>\n` +
        `Факт: <b>${snapshot.today.conversion.toFixed(2)}%</b>, ` +
        `порог: <b>${(conversionPlan * 0.7).toFixed(2)}%</b>`,
    });
  }

  // ── Рекламный бюджет почти исчерпан ─────────────────────────────
  if (adBudgetPlan > 0 && snapshot.month.adSpend >= adBudgetPlan * 0.85) {
    alerts.push({
      code: "ad_budget_high",
      message:
        `⚠️ <b>Рекламный бюджет почти исчерпан</b>\n` +
        `Израсходовано: <b>${Math.round((snapshot.month.adSpend / adBudgetPlan) * 100)}%</b>`,
    });
  }

  // ── Выручка отстаёт от плана ─────────────────────────────────────
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

  // ── Заказов значительно меньше плана ────────────────────────────
  if (dayOrdersPlan > 0 && snapshot.today.orders < dayOrdersPlan * 0.4) {
    alerts.push({
      code: "orders_low",
      message:
        `📦 <b>Заказов значительно меньше плана</b>\n` +
        `Факт: <b>${Math.round(snapshot.today.orders)}</b>, ` +
        `план: <b>${dayOrdersPlan}</b>`,
    });
  }

  // ── Товар в зоне риска ───────────────────────────────────────────
  if (snapshot.atRiskProducts.length > 0) {
    const atRisk = snapshot.atRiskProducts[0];
    alerts.push({
      code: "product_at_risk",
      message:
        `🚨 <b>Товар в зоне риска</b>\n` +
        `<b>${atRisk.name}</b>\n${atRisk.reason}`,
    });
  }

  // ── Негативные отзывы ────────────────────────────────────────────
  const badReviews = (snapshot.badReviews || []);
  if (badReviews.length > 0) {
    const review = badReviews[0];
    alerts.push({
      code: "bad_review",
      message:
        `⭐ <b>Новый негативный отзыв</b>
` +
        `Товар: <b>${review.productName}</b>
` +
        `Оценка: ${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)} (${review.rating}/5)
` +
        `"${review.text ? review.text.slice(0, 120) : "без текста"}"`,
    });
  }

  // ── Сравнение с прошлой неделей — падение выручки ────────────────
  if (snapshot.weekRevenueDelta !== undefined && snapshot.weekRevenueDelta < -15) {
    alerts.push({
      code: "week_revenue_drop",
      message:
        `📉 <b>Выручка падает по сравнению с прошлой неделей</b>
` +
        `Снижение: <b>${Math.abs(snapshot.weekRevenueDelta).toFixed(1)}%</b>
` +
        `Проверьте рекламу и наличие товара на складах`,
    });
  }

  // ── Срочная поставка нужна ────────────────────────────────────────
  const SUPPLY_DAYS = (kpi.supply_days && kpi.supply_days > 0) ? Number(kpi.supply_days) : 14;
  const urgentStocks = snapshot.stocks.filter(s => s.daysCover < SUPPLY_DAYS);
  if (urgentStocks.length > 0) {
    const names = urgentStocks.slice(0, 3).map(s => s.name).join(", ");
    alerts.push({
      code: "supply_urgent",
      message:
        `🚛 <b>Срочно везти на склад!</b>\n` +
        `Товары заканчиваются (менее ${SUPPLY_DAYS} дней):\n` +
        `<b>${names}</b>\n` +
        `Нужно организовать поставку немедленно`,
    });
  }

  return alerts;
}

module.exports = {
  buildAlerts,
};
