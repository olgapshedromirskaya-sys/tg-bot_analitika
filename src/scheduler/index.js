const cron = require("node-cron");
const { getAnalyticsSnapshot } = require("../api/analytics");
const { buildAlerts } = require("./alerts");
const { formatMonthMessage, formatStatsMessage } = require("../bot/dashboard");
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

  const alertJob = cron.schedule(
    "0 */2 * * *",
    async () => {
      const receivers = getReceivers(db, "marketer");
      if (!receivers.length) {
        return;
      }

      const kpi = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      const alerts = buildAlerts(snapshot, kpi);

      if (!alerts.length) {
        return;
      }

      for (const receiver of receivers) {
        for (const alert of alerts) {
          db.saveAlert({ telegramId: receiver, code: alert.code, message: alert.message });
          await safeSend(bot, receiver, alert.message);
        }
      }
    },
    { timezone },
  );

  const morningJob = cron.schedule(
    "0 9 * * *",
    async () => {
      const receivers = getReceivers(db, "owner");
      if (!receivers.length) {
        return;
      }

      const kpi = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      const message = `🌅 <b>Утренний отчёт</b>\n\n${formatStatsMessage(snapshot, kpi)}`;

      for (const receiver of receivers) {
        await safeSend(bot, receiver, message);
      }
    },
    { timezone },
  );

  const eveningJob = cron.schedule(
    "0 20 * * *",
    async () => {
      const receivers = getReceivers(db, "manager");
      if (!receivers.length) {
        return;
      }

      const kpi = db.getKpiSettings();
      const snapshot = await getAnalyticsSnapshot();
      const message = `🌆 <b>Итоговый отчёт дня</b>\n\n${formatMonthMessage(snapshot, kpi)}`;

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
      eveningJob.stop();
    },
  };
}

module.exports = {
  startScheduler,
};
