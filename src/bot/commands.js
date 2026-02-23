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
const { hasAccess, normalizeRole, roleLabel } = require("./roles");

const KPI_KEYS = new Set(["revenue", "conversion", "ad_budget", "daily_orders"]);

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
    role: "viewer",
    name: resolveDisplayName(ctx),
    addedBy: "public_registration",
  });

  return db.getUserByTelegramId(telegramId);
}

async function requireKnownUser(ctx, db) {
  const user = getOrCreateUser(ctx, db);
  if (!user) {
    await ctx.reply(
      "⛔ Доступ закрыт. Попросите владельца добавить вас командой:\n<code>/adduser ваш_id viewer Имя</code>",
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
    await ctx.reply(`⛔ Недостаточно прав. Нужна роль: ${roleLabel(role)}.`);
    return null;
  }
  return user;
}

function createMainKeyboard() {
  return Markup.keyboard([
    ["📊 Дашборд за сегодня",   "📅 Отчёт за месяц"],
    ["📦 Остатки на складах",   "📈 Отчёт за неделю"],
    ["📊 ДРР",                  "🛍️ Выкуп товаров"],
    ["🔄 Оборачиваемость",      "🚨 Товары в зоне риска"],
    ["⚙️ Настройки KPI",        "👥 Список пользователей"],
    ["🚀 Открыть WebApp дашборд"],
  ])
    .resize()
    .persistent();
}

function formatUsers(users) {
  if (!users.length) return "👥 Пользователи пока не добавлены.";
  const lines = ["👥 <b>Пользователи</b>", ""];
  for (const user of users) {
    const name = user.name ? escapeHtml(user.name) : "—";
    lines.push(
      `• <code>${user.telegram_id}</code> — <b>${roleLabel(user.role)}</b> (${user.role})`,
      `  Имя: ${name}`,
    );
  }
  return lines.join("\n");
}

function formatHelp() {
  return [
    "💬 <b>Команды</b>",
    "",
    "/stats — дашборд за сегодня",
    "/month — отчёт за месяц",
    "/week — отчёт за неделю",
    "/stocks — остатки на складах",
    "/drr — ДРР по платформам",
    "/redemption — выкуп товаров",
    "/turnover — оборачиваемость",
    "/risk — товары в зоне риска",
    "/app — открыть WebApp",
    "/settings — текущие KPI",
    "/setkpi revenue 5000000 — изменить KPI",
    "/adduser 123456 manager Алексей — добавить пользователя",
    "/removeuser 123456 — удалить пользователя",
    "/users — список пользователей",
  ].join("\n");
}

function registerCommands(bot, db) {
  // ── Команды в меню Telegram ──────────────────────────────────────
  bot.telegram.setMyCommands([
    { command: "stats",      description: "📊 Дашборд за сегодня" },
    { command: "month",      description: "📅 Отчёт за месяц" },
    { command: "week",       description: "📈 Отчёт за неделю" },
    { command: "stocks",     description: "📦 Остатки на складах" },
    { command: "drr",        description: "📊 ДРР — доля рекламных расходов" },
    { command: "redemption", description: "🛍️ Выкуп товаров по артикулам" },
    { command: "turnover",   description: "🔄 Оборачиваемость товаров" },
    { command: "risk",       description: "🚨 Товары в зоне риска" },
    { command: "app",        description: "🚀 Открыть WebApp" },
    { command: "settings",   description: "⚙️ Настройки KPI" },
    { command: "users",      description: "👥 Пользователи" },
    { command: "help",       description: "💬 Помощь" },
  ]).catch(() => {});

  bot.start(async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    await ctx.reply(formatHeroMessage(), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...createMainKeyboard(),
    });
    await ctx.reply("Откройте визуальный дашборд WebApp:", createWebAppKeyboard());
  });

  // ── Вспомогательная функция: получить снапшот + kpi ─────────────
  async function withSnapshot(fn) {
    const [snapshot, kpi] = await Promise.all([
      getAnalyticsSnapshot(),
      Promise.resolve(db.getKpiSettings()),
    ]);
    return fn(snapshot, kpi);
  }

  // ────────────────────────────────────────────────────────────────
  // КНОПКИ КЛАВИАТУРЫ
  // ────────────────────────────────────────────────────────────────

  bot.hears("📊 Дашборд за сегодня", async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    const [snapshot, kpi] = [await getAnalyticsSnapshot(), db.getKpiSettings()];
    await ctx.reply(formatStatsMessage(snapshot, kpi), { parse_mode: "HTML", disable_web_page_preview: true });
  });

  bot.hears("📅 Отчёт за месяц", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const [snapshot, kpi] = [await getAnalyticsSnapshot(), db.getKpiSettings()];
    await ctx.reply(formatMonthMessage(snapshot, kpi), { parse_mode: "HTML" });
  });

  bot.hears("📦 Остатки на складах", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const [snapshot, kpi] = [await getAnalyticsSnapshot(), db.getKpiSettings()];
    await ctx.reply(formatStocksMessage(snapshot, kpi), { parse_mode: "HTML" });
  });

  bot.hears("📈 Отчёт за неделю", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const kpi   = db.getKpiSettings();
    const prev  = require("dayjs")().subtract(7, "day");
    const [snapshotNow, snapshotPrev] = await Promise.all([
      getAnalyticsSnapshot(),
      getAnalyticsSnapshot({ date: prev.toDate() }),
    ]);
    await ctx.reply(formatWeeklyMessage(snapshotNow, snapshotPrev, kpi), { parse_mode: "HTML" });
  });

  bot.hears("📊 ДРР", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatDrrMessage(snapshot), { parse_mode: "HTML" });
  });

  bot.hears("🛍️ Выкуп товаров", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatRedemptionMessage(snapshot), { parse_mode: "HTML" });
  });

  bot.hears("🔄 Оборачиваемость", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatTurnoverMessage(snapshot), { parse_mode: "HTML" });
  });

  bot.hears("🚨 Товары в зоне риска", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatRiskMessage(snapshot), { parse_mode: "HTML" });
  });

  bot.hears("⚙️ Настройки KPI", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
    if (!user) return;
    await ctx.reply(formatSettingsMessage(db.getKpiSettings()), { parse_mode: "HTML" });
  });

  bot.hears("👥 Список пользователей", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
    if (!user) return;
    await ctx.reply(formatUsers(db.listUsers()), { parse_mode: "HTML" });
  });

  bot.hears("🚀 Открыть WebApp дашборд", async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    await ctx.reply("Откройте визуальный дашборд WebApp:", createWebAppKeyboard());
  });

  // ────────────────────────────────────────────────────────────────
  // КОМАНДЫ (slash-команды)
  // ────────────────────────────────────────────────────────────────

  bot.command("app", async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    await ctx.reply("Откройте визуальный дашборд WebApp:", createWebAppKeyboard());
  });

  bot.command("help", async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    await ctx.reply(formatHelp(), { parse_mode: "HTML" });
  });

  bot.command("stats", async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    const [snapshot, kpi] = [await getAnalyticsSnapshot(), db.getKpiSettings()];
    await ctx.reply(formatStatsMessage(snapshot, kpi), { parse_mode: "HTML", disable_web_page_preview: true });
  });

  bot.command("month", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const [snapshot, kpi] = [await getAnalyticsSnapshot(), db.getKpiSettings()];
    await ctx.reply(formatMonthMessage(snapshot, kpi), { parse_mode: "HTML" });
  });

  bot.command("stocks", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const [snapshot, kpi] = [await getAnalyticsSnapshot(), db.getKpiSettings()];
    await ctx.reply(formatStocksMessage(snapshot, kpi), { parse_mode: "HTML" });
  });

  bot.command("week", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const kpi  = db.getKpiSettings();
    const prev = require("dayjs")().subtract(7, "day");
    const [snapshotNow, snapshotPrev] = await Promise.all([
      getAnalyticsSnapshot(),
      getAnalyticsSnapshot({ date: prev.toDate() }),
    ]);
    await ctx.reply(formatWeeklyMessage(snapshotNow, snapshotPrev, kpi), { parse_mode: "HTML" });
  });

  bot.command("drr", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatDrrMessage(snapshot), { parse_mode: "HTML" });
  });

  bot.command("redemption", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatRedemptionMessage(snapshot), { parse_mode: "HTML" });
  });

  bot.command("turnover", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatTurnoverMessage(snapshot), { parse_mode: "HTML" });
  });

  bot.command("risk", async (ctx) => {
    const user = await requireRole(ctx, db, "manager");
    if (!user) return;
    const snapshot = await getAnalyticsSnapshot();
    await ctx.reply(formatRiskMessage(snapshot), { parse_mode: "HTML" });
  });

  bot.command("settings", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
    if (!user) return;
    await ctx.reply(formatSettingsMessage(db.getKpiSettings()), { parse_mode: "HTML" });
  });

  bot.command("setkpi", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
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

  bot.command("adduser", async (ctx) => {
    const owner = await requireRole(ctx, db, "owner");
    if (!owner) return;
    const [telegramId, roleRaw, ...nameParts] = parseArgs(ctx);
    const role = normalizeRole(roleRaw);
    const name = nameParts.join(" ").trim();
    if (!telegramId || !/^\d+$/.test(telegramId) || !role) {
      await ctx.reply(
        "Формат: <code>/adduser 123456 manager Алексей</code>\nРоли: owner, manager, marketer, viewer",
        { parse_mode: "HTML" },
      );
      return;
    }
    db.upsertUser({ telegramId, role, name: name || null, addedBy: String(ctx.from.id) });
    await ctx.reply(`✅ Пользователь <code>${telegramId}</code> сохранён с ролью <b>${role}</b>.`, { parse_mode: "HTML" });
  });

  bot.command("removeuser", async (ctx) => {
    const owner = await requireRole(ctx, db, "owner");
    if (!owner) return;
    const [telegramId] = parseArgs(ctx);
    if (!telegramId || !/^\d+$/.test(telegramId)) {
      await ctx.reply("Формат: <code>/removeuser 123456</code>", { parse_mode: "HTML" });
      return;
    }
    if (telegramId === String(ctx.from.id)) {
      await ctx.reply("⛔ Нельзя удалить самого себя.");
      return;
    }
    const removed = db.removeUser(telegramId);
    await ctx.reply(removed ? "✅ Пользователь удалён." : "ℹ️ Пользователь не найден.");
  });

  bot.command("users", async (ctx) => {
    const owner = await requireRole(ctx, db, "owner");
    if (!owner) return;
    await ctx.reply(formatUsers(db.listUsers()), { parse_mode: "HTML" });
  });

  bot.catch(async (error, ctx) => {
    await ctx.reply("⚠️ Ошибка обработки команды. Попробуйте ещё раз.");
    console.error("Bot handler error:", error);
  });
}

module.exports = { registerCommands };
