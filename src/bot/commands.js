const { Markup } = require("telegraf");
const { getAnalyticsSnapshot } = require("../api/analytics");
const {
  formatHeroMessage,
  formatMonthMessage,
  formatSettingsMessage,
  formatStatsMessage,
  formatStocksMessage,
  formatWeeklyMessage,
  formatDrrMessage,
  formatRedemptionMessage,
  formatTurnoverMessage,
  formatRiskMessage,
} = require("./dashboard");
const { hasAccess, canManageUsers, canViewFinance, normalizeRole, roleLabel } = require("./roles");

const KPI_KEYS = new Set(["revenue", "conversion", "ad_budget", "daily_orders"]);

// Роли на русском для ввода пользователем
const ROLE_ALIASES = {
  "руководитель": "owner",
  "администратор": "admin",
  "менеджер":      "manager",
  "owner":         "owner",
  "admin":         "admin",
  "manager":       "manager",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseArgs(ctx) {
  const text = ctx.message?.text || "";
  const [, ...args] = text.trim().split(/\s+/);
  return args;
}

function resolveDisplayName(ctx) {
  const firstName = ctx.from?.first_name || "";
  const lastName  = ctx.from?.last_name  || "";
  const username  = ctx.from?.username ? `@${ctx.from.username}` : "";
  return `${firstName} ${lastName}`.trim() || username || `User ${ctx.from?.id}`;
}

function resolveWebAppUrl() {
  if (process.env.WEBAPP_URL) return process.env.WEBAPP_URL;
  const port = process.env.PORT || process.env.WEBAPP_PORT || 3000;
  return `http://localhost:${port}`;
}

function createWebAppKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.webApp("✈️ Открыть WebApp", resolveWebAppUrl())],
  ]);
}

function getOrCreateUser(ctx, db) {
  const telegramId = String(ctx.from.id);
  const existing = db.getUserByTelegramId(telegramId);
  if (existing) return existing;

  const allowPublic = String(process.env.ALLOW_PUBLIC_REGISTRATION || "false").toLowerCase() === "true";
  if (!allowPublic) return null;

  db.upsertUser({
    telegramId,
    role: "manager",
    name: resolveDisplayName(ctx),
    addedBy: "public_registration",
  });

  return db.getUserByTelegramId(telegramId);
}

async function requireKnownUser(ctx, db) {
  const user = getOrCreateUser(ctx, db);
  if (!user) {
    await ctx.reply(
      "⛔ Доступ закрыт.\nПопросите руководителя добавить вас через команду «👤 Добавить сотрудника».",
      { parse_mode: "HTML" },
    );
    return null;
  }
  return user;
}

async function requireRole(ctx, db, role) {
  const user = await requireKnownUser(ctx, db);
  if (!user) return null;
  if (!hasAccess(user.role, role)) {
    await ctx.reply(`⛔ Недостаточно прав. Требуется роль: <b>${roleLabel(role)}</b>.`, { parse_mode: "HTML" });
    return null;
  }
  return user;
}

// Клавиатура зависит от роли пользователя
function createMainKeyboard(userRole) {
  const rows = [
    ["📊 Дашборд за сегодня",  "📅 Отчёт за месяц"],
    ["📦 Остатки на складах",  "📈 Отчёт за неделю"],
    ["📊 ДРР",                 "🛍️ Выкуп товаров"],
    ["🔄 Оборачиваемость",     "🚨 Товары в зоне риска"],
  ];

  // Финансы — только admin и owner
  if (canViewFinance(userRole)) {
    rows.push(["⚙️ Настройки KPI"]);
  }

  // Управление сотрудниками — только owner
  if (canManageUsers(userRole)) {
    rows.push(["👤 Добавить сотрудника", "❌ Удалить сотрудника"]);
    rows.push(["👥 Список сотрудников"]);
  }

  rows.push(["🚀 Открыть WebApp дашборд"]);

  return Markup.keyboard(rows).resize().persistent();
}

function formatUsers(users) {
  if (!users.length) return "👥 Сотрудники пока не добавлены.";
  const lines = ["👥 <b>Сотрудники</b>", ""];
  for (const user of users) {
    const name = user.name ? escapeHtml(user.name) : "—";
    const role = roleLabel(user.role);
    lines.push(`• <b>${name}</b> — ${role}`);
    lines.push(`  ID: <code>${user.telegram_id}</code>`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatHelp(userRole) {
  const lines = [
    "💬 <b>Доступные команды</b>",
    "",
    "📊 Дашборд за сегодня — текущие показатели",
    "📅 Отчёт за месяц — выполнение плана",
    "📈 Отчёт за неделю — сравнение с прошлой",
    "📦 Остатки на складах — запасы и поставки",
    "📊 ДРР — доля рекламных расходов по артикулам",
    "🛍️ Выкуп товаров — процент выкупа по артикулам",
    "🔄 Оборачиваемость — сколько дней лежит товар",
    "🚨 Товары в зоне риска — проблемные артикулы",
  ];

  if (canViewFinance(userRole)) {
    lines.push("⚙️ Настройки KPI — плановые показатели");
  }

  if (canManageUsers(userRole)) {
    lines.push("");
    lines.push("👤 Добавить сотрудника — выдать доступ");
    lines.push("❌ Удалить сотрудника — забрать доступ");
    lines.push("👥 Список сотрудников — все пользователи");
  }

  lines.push("");
  lines.push("🚀 Открыть WebApp дашборд — визуальный интерфейс");

  return lines.join("\n");
}

// ── Сценарий добавления сотрудника (мультишаг) ──────────────────────
// Хранит промежуточное состояние в памяти (достаточно для небольших команд)
const addUserState = {};

function registerCommands(bot, db) {

  // ── Меню Telegram ────────────────────────────────────────────────
  bot.telegram.setMyCommands([
    { command: "start",  description: "🚀 Главное меню" },
    { command: "help",   description: "💬 Список команд" },
    { command: "app",    description: "✈️ Открыть WebApp" },
  ]).catch(() => {});

  // ── /start ───────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    await ctx.reply(formatHeroMessage(), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...createMainKeyboard(user.role),
    });
    await ctx.reply("Откройте визуальный дашборд WebApp:", createWebAppKeyboard());
  });

  // ── /help ────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    await ctx.reply(formatHelp(user.role), { parse_mode: "HTML" });
  });

  // ── /app ─────────────────────────────────────────────────────────
  bot.command("app", async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    await ctx.reply("Откройте визуальный дашборд WebApp:", createWebAppKeyboard());
  });

  // ════════════════════════════════════════════════════════════════
  // АНАЛИТИКА — кнопки и команды
  // ════════════════════════════════════════════════════════════════

  async function sendStats(ctx, db) {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    const [snapshot, kpi] = [await getAnalyticsSnapshot(), db.getKpiSettings()];
    await ctx.reply(formatStatsMessage(snapshot, kpi), { parse_mode: "HTML", disable_web_page_preview: true });
  }

  async function sendMonth(ctx, db) {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const [snapshot, kpi] = [await getAnalyticsSnapshot(), db.getKpiSettings()];
    // Финансовый блок в отчёте за месяц — только для admin/owner
    const snap = canViewFinance(user.role) ? snapshot : hideFinance(snapshot);
    await ctx.reply(formatMonthMessage(snap, kpi), { parse_mode: "HTML" });
  }

  async function sendStocks(ctx, db) {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const [snapshot, kpi] = [await getAnalyticsSnapshot(), db.getKpiSettings()];
    await ctx.reply(formatStocksMessage(snapshot, kpi), { parse_mode: "HTML" });
  }

  async function sendWeek(ctx, db) {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const kpi  = db.getKpiSettings();
    const prev = require("dayjs")().subtract(7, "day");
    const [snapshotNow, snapshotPrev] = await Promise.all([
      getAnalyticsSnapshot(),
      getAnalyticsSnapshot({ date: prev.toDate() }),
    ]);
    const now  = canViewFinance(user.role) ? snapshotNow  : hideFinance(snapshotNow);
    const prev2= canViewFinance(user.role) ? snapshotPrev : hideFinance(snapshotPrev);
    await ctx.reply(formatWeeklyMessage(now, prev2, kpi), { parse_mode: "HTML" });
  }

  async function sendDrr(ctx, db) {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatDrrMessage(snapshot), { parse_mode: "HTML" });
  }

  async function sendRedemption(ctx, db) {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatRedemptionMessage(snapshot), { parse_mode: "HTML" });
  }

  async function sendTurnover(ctx, db) {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatTurnoverMessage(snapshot), { parse_mode: "HTML" });
  }

  async function sendRisk(ctx, db) {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatRiskMessage(snapshot), { parse_mode: "HTML" });
  }

  // Скрыть финансовые данные (для менеджера)
  function hideFinance(snapshot) {
    if (!snapshot) return snapshot;
    return {
      ...snapshot,
      channels: (snapshot.channels || []).map(c => ({
        ...c,
        today: { ...c.today, adSpend: undefined },
        month: { ...c.month, adSpend: undefined },
      })),
    };
  }

  // ── Кнопки аналитики ─────────────────────────────────────────────
  bot.hears("📊 Дашборд за сегодня",  ctx => sendStats(ctx, db));
  bot.hears("📅 Отчёт за месяц",      ctx => sendMonth(ctx, db));
  bot.hears("📦 Остатки на складах",  ctx => sendStocks(ctx, db));
  bot.hears("📈 Отчёт за неделю",     ctx => sendWeek(ctx, db));
  bot.hears("📊 ДРР",                 ctx => sendDrr(ctx, db));
  bot.hears("🛍️ Выкуп товаров",       ctx => sendRedemption(ctx, db));
  bot.hears("🔄 Оборачиваемость",     ctx => sendTurnover(ctx, db));
  bot.hears("🚨 Товары в зоне риска", ctx => sendRisk(ctx, db));

  bot.hears("🚀 Открыть WebApp дашборд", async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    await ctx.reply("Откройте визуальный дашборд WebApp:", createWebAppKeyboard());
  });

  // ── Настройки KPI (admin + owner) ────────────────────────────────
  bot.hears("⚙️ Настройки KPI", async (ctx) => {
    const user = await requireRole(ctx, db, "admin");
    if (!user) return;
    await ctx.reply(formatSettingsMessage(db.getKpiSettings()), { parse_mode: "HTML" });
  });

  // ── /setkpi (admin + owner) ───────────────────────────────────────
  bot.command("setkpi", async (ctx) => {
    const user = await requireRole(ctx, db, "admin");
    if (!user) return;
    const [keyRaw, valueRaw] = parseArgs(ctx);
    const key   = (keyRaw || "").trim().toLowerCase();
    const value = Number(valueRaw);
    if (!KPI_KEYS.has(key) || !Number.isFinite(value) || value <= 0) {
      await ctx.reply(
        "Формат: <code>/setkpi revenue 5000000</code>\nКлючи: revenue, conversion, ad_budget, daily_orders",
        { parse_mode: "HTML" },
      );
      return;
    }
    db.setKpiValue(key, value);
    await ctx.reply(`✅ KPI обновлён: <b>${key}</b> = <b>${value}</b>`, { parse_mode: "HTML" });
  });

  // ════════════════════════════════════════════════════════════════
  // УПРАВЛЕНИЕ СОТРУДНИКАМИ — только owner
  // ════════════════════════════════════════════════════════════════

  // ── 👤 Добавить сотрудника — пошаговый диалог ────────────────────
  bot.hears("👤 Добавить сотрудника", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
    if (!user) return;
    const ownerId = String(ctx.from.id);
    addUserState[ownerId] = { step: "awaiting_id" };
    await ctx.reply(
      "👤 <b>Добавление сотрудника</b>\n\n" +
      "Шаг 1 из 3: Отправьте <b>Telegram ID</b> сотрудника.\n\n" +
      "<i>Чтобы узнать свой ID, сотрудник может написать боту @userinfobot</i>",
      { parse_mode: "HTML" }
    );
  });

  // ── ❌ Удалить сотрудника ─────────────────────────────────────────
  bot.hears("❌ Удалить сотрудника", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
    if (!user) return;
    const users = db.listUsers().filter(u => u.telegram_id !== String(ctx.from.id));
    if (!users.length) {
      await ctx.reply("Сотрудников для удаления нет.");
      return;
    }
    const list = users.map((u, i) =>
      `${i + 1}. <b>${escapeHtml(u.name || "—")}</b> (${roleLabel(u.role)}) — <code>${u.telegram_id}</code>`
    ).join("\n");

    await ctx.reply(
      `❌ <b>Удаление сотрудника</b>\n\nОтправьте <b>Telegram ID</b> сотрудника которого хотите удалить:\n\n${list}`,
      { parse_mode: "HTML" }
    );
    addUserState[String(ctx.from.id)] = { step: "awaiting_remove_id" };
  });

  // ── 👥 Список сотрудников ─────────────────────────────────────────
  bot.hears("👥 Список сотрудников", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
    if (!user) return;
    await ctx.reply(formatUsers(db.listUsers()), { parse_mode: "HTML" });
  });

  // ── Обработка пошагового ввода ────────────────────────────────────
  bot.on("text", async (ctx) => {
    const ownerId = String(ctx.from.id);
    const state   = addUserState[ownerId];
    const text    = (ctx.message?.text || "").trim();

    // Пропускаем если это команда или кнопка клавиатуры
    if (text.startsWith("/") || !state) return;

    // ── Шаг: ожидаем ID для удаления ─────────────────────────────
    if (state.step === "awaiting_remove_id") {
      delete addUserState[ownerId];
      if (!/^\d+$/.test(text)) {
        await ctx.reply("⛔ Неверный формат ID. Должны быть только цифры.");
        return;
      }
      if (text === ownerId) {
        await ctx.reply("⛔ Нельзя удалить самого себя.");
        return;
      }
      const removed = db.removeUser(text);
      if (removed) {
        await ctx.reply(`✅ Сотрудник <code>${text}</code> удалён.`, { parse_mode: "HTML" });
      } else {
        await ctx.reply(`ℹ️ Сотрудник с ID <code>${text}</code> не найден.`, { parse_mode: "HTML" });
      }
      return;
    }

    // ── Шаг 1: получаем Telegram ID ──────────────────────────────
    if (state.step === "awaiting_id") {
      if (!/^\d+$/.test(text)) {
        await ctx.reply("⛔ Неверный формат. ID должен состоять только из цифр. Попробуйте ещё раз:");
        return;
      }
      addUserState[ownerId] = { step: "awaiting_role", telegramId: text };
      await ctx.reply(
        `Шаг 2 из 3: Выберите роль для сотрудника <code>${text}</code>:`,
        {
          parse_mode: "HTML",
          ...Markup.keyboard([
            ["руководитель", "администратор"],
            ["менеджер"],
            ["❌ Отмена"],
          ]).resize().oneTime(),
        }
      );
      return;
    }

    // ── Отмена ────────────────────────────────────────────────────
    if (text === "❌ Отмена" && state) {
      delete addUserState[ownerId];
      const user = db.getUserByTelegramId(ownerId);
      await ctx.reply("Отменено.", createMainKeyboard(user?.role));
      return;
    }

    // ── Шаг 2: получаем роль ─────────────────────────────────────
    if (state.step === "awaiting_role") {
      const role = ROLE_ALIASES[text.toLowerCase()];
      if (!role) {
        await ctx.reply(
          "⛔ Неизвестная роль. Выберите из кнопок: руководитель, администратор, менеджер",
          {
            ...Markup.keyboard([
              ["руководитель", "администратор"],
              ["менеджер"],
              ["❌ Отмена"],
            ]).resize().oneTime(),
          }
        );
        return;
      }
      addUserState[ownerId] = { ...state, step: "awaiting_name", role };
      await ctx.reply(
        `Шаг 3 из 3: Введите имя сотрудника (или отправьте «-» чтобы пропустить):`,
        Markup.removeKeyboard()
      );
      return;
    }

    // ── Шаг 3: получаем имя и сохраняем ──────────────────────────
    if (state.step === "awaiting_name") {
      const name = text === "-" ? null : text;
      delete addUserState[ownerId];

      db.upsertUser({
        telegramId: state.telegramId,
        role: state.role,
        name,
        addedBy: ownerId,
      });

      const user = db.getUserByTelegramId(ownerId);
      await ctx.reply(
        `✅ <b>Сотрудник добавлен</b>\n\n` +
        `ID: <code>${state.telegramId}</code>\n` +
        `Роль: <b>${roleLabel(state.role)}</b>\n` +
        `Имя: <b>${escapeHtml(name || "не указано")}</b>`,
        {
          parse_mode: "HTML",
          ...createMainKeyboard(user?.role),
        }
      );
      return;
    }
  });

  // ── /settings, /users совместимость ──────────────────────────────
  bot.command("settings", async (ctx) => {
    const user = await requireRole(ctx, db, "admin");
    if (!user) return;
    await ctx.reply(formatSettingsMessage(db.getKpiSettings()), { parse_mode: "HTML" });
  });

  bot.command("users", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
    if (!user) return;
    await ctx.reply(formatUsers(db.listUsers()), { parse_mode: "HTML" });
  });

  // ── Команды аналитики (slash) ─────────────────────────────────────
  bot.command("stats",      ctx => sendStats(ctx, db));
  bot.command("month",      ctx => sendMonth(ctx, db));
  bot.command("stocks",     ctx => sendStocks(ctx, db));
  bot.command("week",       ctx => sendWeek(ctx, db));
  bot.command("drr",        ctx => sendDrr(ctx, db));
  bot.command("redemption", ctx => sendRedemption(ctx, db));
  bot.command("turnover",   ctx => sendTurnover(ctx, db));
  bot.command("risk",       ctx => sendRisk(ctx, db));

  bot.catch(async (error, ctx) => {
    await ctx.reply("⚠️ Ошибка обработки команды. Попробуйте ещё раз.");
    console.error("Bot handler error:", error);
  });
}

module.exports = { registerCommands };
