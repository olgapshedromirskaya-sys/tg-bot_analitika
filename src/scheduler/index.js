const cron = require("node-cron");
const dayjs = require("dayjs");
const { getAnalyticsSnapshot } = require("../api/analytics");
const { buildAlerts, buildUrgentAlerts, detectOrderAnomalies } = require("./alerts");
const {
  formatStatsMessage,
  formatMonthMessage,
  formatStocksMessage,
  formatWeeklyMessage,
  formatDrrMessage,
  formatRedemptionMessage,
  formatTurnoverMessage,
  formatRiskMessage,
} = require("../bot/dashboard");
const { hasAccess } = require("../bot/roles");

async function safeSend(bot, telegramId, message) {
  try {
    await bot.telegram.sendMessage(telegramId, message, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch {
    // пользователь заблокировал бота или чат недоступен
  }
}

function getReceivers(db, minRole) {
  return db
    .listUsers()
    .filter(user => hasAccess(user.role, minRole))
    .map(user => user.telegram_id);
}

function isDemo(snapshot) {
  const channels = snapshot.channels || [];
  return channels.every(c => c.source !== "api");
}

// ── Форматирование сообщения об аномалии ─────────────────────────────
function formatAnomalyAlert(a) {
  const lvl = a.ratio >= 3 && !a.hasAd ? "🔴 КРИТИЧНО" : a.hasAd ? "🟡 Проверить" : "🟠 Подозрительно";
  const adNote = a.hasAd
    ? `📢 На артикул запущена реклама — возможен органический эффект кампании`
    : `⚠️ Реклама не запущена — рост без объяснимой причины`;
  const recommendation = a.hasAd
    ? `Проверьте CTR и конверсию — если в норме, это органика`
    : `Временно скройте товар или поднимите цену на 20–30%`;

  return (
    `🚨 <b>Аномалия заказов — ${a.label}</b>\n\n` +
    `${lvl}\n` +
    `<b>${a.name}</b>${a.sku ? ` <code>${a.sku}</code>` : ""}\n\n` +
    `Обычно: ~<b>${a.avgDaily} шт/день</b>\n` +
    `Сегодня: <b>${a.todayOrders} шт</b> (×${a.ratio.toFixed(1)})\n` +
    `На складе: <b>${a.qty.toLocaleString("ru")} шт</b>\n\n` +
    `${adNote}\n\n` +
    `💡 <b>Что делать:</b> ${recommendation}`
  );
}

// Антиспам для аномалий — отдельный объект чтобы не мешать alertCooldowns
const anomalySentAt = {};

function canSendAnomaly(key) {
  const COOLDOWN = 2 * 60 * 60 * 1000; // 2 часа
  const last = anomalySentAt[key] || 0;
  if (Date.now() - last > COOLDOWN) {
    anomalySentAt[key] = Date.now();
    return true;
  }
  return false;
}

function startScheduler({ bot, db }) {
  const timezone = process.env.TIMEZONE || "Europe/Moscow";

  // ────────────────────────────────────────────────────────────────
  // ВНЕПЛАНОВЫЕ АЛЕРТЫ — каждые 30 минут
  // Включает аномалии заказов (проверяются в первую очередь)
  // ────────────────────────────────────────────────────────────────
  cron.schedule("*/30 * * * *", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi      = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      // ── 🚨 Аномалии заказов — проверяем отдельно с собственным кулдауном
      const anomalies = detectOrderAnomalies(snapshot);
      for (const a of anomalies) {
        const key = `${a.label}_${a.sku || a.name}`;
        if (!canSendAnomaly(key)) continue;
        const msg = formatAnomalyAlert(a);
        for (const r of receivers) {
          await safeSend(bot, r, msg);
        }
        console.log(`[Scheduler] Аномалия заказов: ${a.label} ${a.sku} ×${a.ratio.toFixed(1)}`);
      }

      // ── Остальные срочные алерты
      const urgentAlerts = buildUrgentAlerts(snapshot, kpi);
      if (!urgentAlerts.length) return;

      for (const receiver of receivers) {
        for (const alert of urgentAlerts) {
          db.saveAlert?.({ telegramId: receiver, code: alert.code, message: alert.message });
          await safeSend(bot, receiver, alert.message);
        }
      }
    } catch (e) {
      console.error("[Scheduler] Ошибка внеплановых алертов:", e.message);
    }
  }, { timezone });

  // ────────────────────────────────────────────────────────────────
  // ПЛАНОВЫЕ АЛЕРТЫ — каждые 2 часа (не срочные)
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 */2 * * *", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi      = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      const allAlerts     = buildAlerts(snapshot, kpi);
      const plannedAlerts = allAlerts.filter(a => !a.urgent);
      if (!plannedAlerts.length) return;

      for (const receiver of receivers) {
        for (const alert of plannedAlerts) {
          db.saveAlert?.({ telegramId: receiver, code: alert.code, message: alert.message });
          await safeSend(bot, receiver, alert.message);
        }
      }
    } catch (e) {
      console.error("[Scheduler] Ошибка плановых алертов:", e.message);
    }
  }, { timezone });

  // ────────────────────────────────────────────────────────────────
  // 8:00 — Остатки и поставки (утро)
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 8 * * *", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi      = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      const msg = `🌅 <b>Остатки и поставки — утро</b>\n\n${formatStocksMessage(snapshot, kpi)}`;
      for (const r of receivers) await safeSend(bot, r, msg);
    } catch (e) { console.error("[Scheduler 08:00 stocks]", e.message); }
  }, { timezone });

  // ────────────────────────────────────────────────────────────────
  // 9:00 — Дашборд + ДРР (утро)
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 9 * * *", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi      = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      const dashMsg = `🌅 <b>Доброе утро! Дашборд за сегодня</b>\n\n${formatStatsMessage(snapshot, kpi)}`;
      const drrMsg  = formatDrrMessage(snapshot);

      for (const r of receivers) {
        await safeSend(bot, r, dashMsg);
        await safeSend(bot, r, drrMsg);
      }
    } catch (e) { console.error("[Scheduler 09:00 dash+drr]", e.message); }
  }, { timezone });

  // ────────────────────────────────────────────────────────────────
  // 10:00 — Отчёт за месяц + Выкуп% + Оборачиваемость
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 10 * * *", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi      = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      const monthMsg      = formatMonthMessage(snapshot, kpi);
      const redemptionMsg = formatRedemptionMessage(snapshot);
      const turnoverMsg   = formatTurnoverMessage(snapshot);

      for (const r of receivers) {
        await safeSend(bot, r, monthMsg);
        await safeSend(bot, r, redemptionMsg);
        await safeSend(bot, r, turnoverMsg);
      }
    } catch (e) { console.error("[Scheduler 10:00 month+redemption+turnover]", e.message); }
  }, { timezone });

  // ────────────────────────────────────────────────────────────────
  // 11:00 по понедельникам — Еженедельный отчёт
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 11 * * 1", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi      = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      const prev         = dayjs().subtract(7, "day");
      const snapshotPrev = await getAnalyticsSnapshot({ date: prev.toDate() });
      const msg          = formatWeeklyMessage(snapshot, snapshotPrev, kpi);
      for (const r of receivers) await safeSend(bot, r, msg);
    } catch (e) { console.error("[Scheduler 11:00 weekly]", e.message); }
  }, { timezone });

  // ────────────────────────────────────────────────────────────────
  // 14:00 — Остатки и поставки (день)
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 14 * * *", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi      = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      const msg = `☀️ <b>Остатки и поставки — день</b>\n\n${formatStocksMessage(snapshot, kpi)}`;
      for (const r of receivers) await safeSend(bot, r, msg);
    } catch (e) { console.error("[Scheduler 14:00 stocks]", e.message); }
  }, { timezone });

  // ────────────────────────────────────────────────────────────────
  // 15:00 — Товары в зоне риска (день)
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 15 * * *", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      const msg = formatRiskMessage(snapshot);
      for (const r of receivers) await safeSend(bot, r, msg);
    } catch (e) { console.error("[Scheduler 15:00 risk]", e.message); }
  }, { timezone });

  // ────────────────────────────────────────────────────────────────
  // 19:00 — Дашборд + ДРР (вечер)
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 19 * * *", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi      = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      const dashMsg = `🌆 <b>Вечерний дашборд</b>\n\n${formatStatsMessage(snapshot, kpi)}`;
      const drrMsg  = formatDrrMessage(snapshot);

      for (const r of receivers) {
        await safeSend(bot, r, dashMsg);
        await safeSend(bot, r, drrMsg);
      }
    } catch (e) { console.error("[Scheduler 19:00 dash+drr]", e.message); }
  }, { timezone });

  // ────────────────────────────────────────────────────────────────
  // 20:00 — Остатки + Выкуп% + Оборачиваемость + Риски (вечер)
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 20 * * *", async () => {
    try {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi      = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      if (isDemo(snapshot)) return;

      const stocksMsg     = `🌙 <b>Остатки и поставки — вечер</b>\n\n${formatStocksMessage(snapshot, kpi)}`;
      const redemptionMsg = formatRedemptionMessage(snapshot);
      const turnoverMsg   = formatTurnoverMessage(snapshot);
      const riskMsg       = formatRiskMessage(snapshot);

      for (const r of receivers) {
        await safeSend(bot, r, stocksMsg);
        await safeSend(bot, r, redemptionMsg);
        await safeSend(bot, r, turnoverMsg);
        await safeSend(bot, r, riskMsg);
      }
    } catch (e) { console.error("[Scheduler 20:00 evening]", e.message); }
  }, { timezone });
}

module.exports = { startScheduler };
