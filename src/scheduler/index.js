const cron = require("node-cron");
const { getAnalyticsSnapshot } = require("../api/analytics");
const { buildAlerts } = require("./alerts");
const {
  formatMonthMessage,
  formatStatsMessage,
  formatStocksMessage,
  formatWeeklyMessage,
} = require("../bot/dashboard");
const { hasAccess } = require("../bot/roles");

async function safeSend(bot, telegramId, message) {
  try {
    await bot.telegram.sendMessage(telegramId, message, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (error) {
    // If a user blocked the bot or chat is unavailable, skip silently.
  }
}

function getReceivers(db, minRole) {
  return db
    .listUsers()
    .filter((user) => hasAccess(user.role, minRole))
    .map((user) => user.telegram_id);
}

function startScheduler({ bot, db }) {
  const timezone = process.env.TIMEZONE || "Europe/Moscow";

  // ── Алерты — каждые 2 часа (важные уведомления о проблемах) ────
  const alertJob = cron.schedule(
    "0 */2 * * *",
    async () => {
      const receivers = getReceivers(db, "marketer");
      if (!receivers.length) return;
      const kpi = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      const alerts = buildAlerts(snapshot, kpi);
      if (!alerts.length) return;
      for (const receiver of receivers) {
        for (const alert of alerts) {
          db.saveAlert({ telegramId: receiver, code: alert.code, message: alert.message });
          await safeSend(bot, receiver, alert.message);
        }
      }
    },
    { timezone },
  );

  // ── Утро 9:00 — дашборд + месячный отчёт + остатки ─────────────
  const morningJob = cron.schedule(
    "0 9 * * *",
    async () => {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();

      const dashMsg   = `🌅 <b>Доброе утро! Дашборд за сегодня</b>\n\n${formatStatsMessage(snapshot, kpi)}`;
      const monthMsg  = formatMonthMessage(snapshot, kpi);
      const stocksMsg = formatStocksMessage(snapshot, kpi);

      for (const receiver of receivers) {
        await safeSend(bot, receiver, dashMsg);
        await safeSend(bot, receiver, monthMsg);
        await safeSend(bot, receiver, stocksMsg);
      }
    },
    { timezone },
  );

  // ── День 14:00 — только дашборд ─────────────────────────────────
  const afternoonJob = cron.schedule(
    "0 14 * * *",
    async () => {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      const message = `☀️ <b>Дневной дашборд</b>\n\n${formatStatsMessage(snapshot, kpi)}`;
      for (const receiver of receivers) {
        await safeSend(bot, receiver, message);
      }
    },
    { timezone },
  );

  // ── Вечер 19:00 — дашборд + остатки ────────────────────────────
  const eveningJob = cron.schedule(
    "0 19 * * *",
    async () => {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();

      const dashMsg   = `🌆 <b>Вечерний дашборд</b>\n\n${formatStatsMessage(snapshot, kpi)}`;
      const stocksMsg = formatStocksMessage(snapshot, kpi);

      for (const receiver of receivers) {
        await safeSend(bot, receiver, dashMsg);
        await safeSend(bot, receiver, stocksMsg);
      }
    },
    { timezone },
  );

  // ── Понедельник 11:00 — еженедельный отчёт ──────────────────────
  const weeklyJob = cron.schedule(
    "0 11 * * 1",
    async () => {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) return;
      const kpi = db.getKpiSettings();

      // Получаем данные за текущую и прошлую неделю
      const now  = require("dayjs")();
      const prev = now.subtract(7, "day");

      const [snapshotNow, snapshotPrev] = await Promise.all([
        getAnalyticsSnapshot(),
        getAnalyticsSnapshot({ date: prev.toDate() }),
      ]);

      const message = formatWeeklyMessage(snapshotNow, snapshotPrev, kpi);
      for (const receiver of receivers) {
        await safeSend(bot, receiver, message);
      }
    },
    { timezone },
  );

  return {
    stop() {
      alertJob.stop();
      morningJob.stop();
      afternoonJob.stop();
      eveningJob.stop();
      weeklyJob.stop();
    },
  };
}

module.exports = {
  startScheduler,
};
