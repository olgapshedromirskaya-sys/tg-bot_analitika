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
const KPI_LABELS = {
  revenue:      "Выручка (мес)",
  conversion:   "Конверсия %",
  ad_budget:    "Рекл. бюджет (мес)",
  daily_orders: "Заказы в день",
};

// Состояние диалога изменения KPI
const kpiState = {};

// Роли на русском для ввода пользователем
const ROLE_ALIASES = {
  "руководитель": "owner",
  "администратор": "admin",
  "менеджер":      "manager",
  "тестировщик":   "tester",
  "owner":         "owner",
  "admin":         "admin",
  "manager":       "manager",
  "tester":        "tester",
};

// ─────────────────────────────────────────────────────────────────────
// Роль tester:
//   ✅ видит все аналитические блоки (дашборд, финансы, KPI)
//   ✅ видит форму настроек, но поля API неактивны (disabled)
//   ❌ не может добавлять/удалять сотрудников (кнопки скрыты)
//   ❌ не может реально сохранить API-ключи (запрос отклоняется)
// Проверки используются в:
//   - createMainKeyboard (скрыть кнопки сотрудников)
//   - API endpoint /api/credentials (отклонить сохранение)
//   - webapp/index.html (disabled поля — см. флаг source:'demo' или заголовок X-Role)
// ─────────────────────────────────────────────────────────────────────

function isTester(userRole) {
  return normalizeRole(userRole) === "tester";
}

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
  // tester имеет доступ ко всей аналитике (как admin), но не к управлению
  if (isTester(user.role) && role !== "owner") return user;
  if (!hasAccess(user.role, role)) {
    await ctx.reply(`⛔ Недостаточно прав. Требуется роль: <b>${roleLabel(role)}</b>.`, { parse_mode: "HTML" });
    return null;
  }
  return user;
}

// ── Список кнопок-команд которые должны сбрасывать диалог ──────────
const MENU_BUTTONS = new Set([
  "📊 Дашборд за сегодня", "📅 Отчёт за месяц",
  "📦 Остатки на складах", "📈 Отчёт за неделю",
  "📊 ДРР", "🛍️ Выкуп товаров",
  "🔄 Оборачиваемость", "🚨 Товары в зоне риска",
  "⚙️ Настройки KPI", "✏️ Изменить KPI",
  "👤 Добавить сотрудника", "❌ Удалить сотрудника",
  "👥 Список сотрудников", "🚀 Открыть WebApp дашборд",
]);

// Клавиатура зависит от роли пользователя
function createMainKeyboard(userRole) {
  const rows = [
    ["📊 Дашборд за сегодня",  "📅 Отчёт за месяц"],
    ["📦 Остатки на складах",  "📈 Отчёт за неделю"],
    ["📊 ДРР",                 "🛍️ Выкуп товаров"],
    ["🔄 Оборачиваемость",     "🚨 Товары в зоне риска"],
  ];

  // Финансы — admin, owner и tester (tester видит, но не может менять)
  if (canViewFinance(userRole) || isTester(userRole)) {
    rows.push(["⚙️ Настройки KPI", "✏️ Изменить KPI"]);
  }

  // Управление сотрудниками — только owner (tester не видит)
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

  if (canViewFinance(userRole) || isTester(userRole)) {
    lines.push("⚙️ Настройки KPI — плановые показатели");
    if (!isTester(userRole)) {
      lines.push("✏️ Изменить KPI — обновить плановые показатели");
    }
  }

  if (canManageUsers(userRole)) {
    lines.push("");
    lines.push("👤 Добавить сотрудника — выдать доступ");
    lines.push("❌ Удалить сотрудника — забрать доступ");
    lines.push("👥 Список сотрудников — все пользователи");
  }

  lines.push("");
  lines.push("🚀 Открыть WebApp дашборд — визуальный интерфейс");

  if (isTester(userRole)) {
    lines.push("");
    lines.push("ℹ️ <i>Тестовый режим: добавление API-ключей недоступно</i>");
  }

  return lines.join("\n");
}

// ── Сценарий добавления сотрудника (мультишаг) ──────────────────────
const addUserState = {};

function registerCommands(bot, db) {

  // ════════════════════════════════════════════════════════════════
  // MIDDLEWARE мультишага — ПЕРВЫМ, до всех hears/command/start
  // ════════════════════════════════════════════════════════════════
  bot.use(async (ctx, next) => {
    if (!ctx.message?.text) return next();

    const userId = String(ctx.from?.id);
    const text   = ctx.message.text.trim();
    const addSt  = addUserState[userId];
    const kpiSt  = kpiState[userId];

    // Нет активного диалога — передаём дальше
    if (!addSt && !kpiSt) return next();

    // ── FIX: если пользователь нажал кнопку меню — сбрасываем диалог
    // и передаём управление обработчику кнопки как обычно
    if (MENU_BUTTONS.has(text)) {
      delete addUserState[userId];
      delete kpiState[userId];
      return next();
    }

    // ── Отмена на любом шаге любого диалога ──────────────────────
    if (text === "❌ Отмена") {
      delete addUserState[userId];
      delete kpiState[userId];
      const user = db.getUserByTelegramId(userId);
      await ctx.reply("Отменено.", createMainKeyboard(user?.role));
      return;
    }

    // ════════════════════════════════════════════════════════════
    // ДИАЛОГ: ДОБАВЛЕНИЕ/УДАЛЕНИЕ СОТРУДНИКА
    // ════════════════════════════════════════════════════════════
    if (addSt) {
      // Шаг: ожидаем ID для удаления
      if (addSt.step === "awaiting_remove_id") {
        if (!/^\d+$/.test(text)) {
          await ctx.reply("⛔ ID должен состоять только из цифр. Попробуйте ещё раз:");
          return;
        }
        if (text === userId) {
          await ctx.reply("⛔ Нельзя удалить самого себя.");
          return;
        }
        delete addUserState[userId];
        const removed = db.removeUser(text);
        const user = db.getUserByTelegramId(userId);
        await ctx.reply(
          removed
            ? `✅ Сотрудник <code>${text}</code> удалён.`
            : `ℹ️ Сотрудник с ID <code>${text}</code> не найден.`,
          { parse_mode: "HTML", ...createMainKeyboard(user?.role) }
        );
        return;
      }

      // Шаг 1: Telegram ID
      if (addSt.step === "awaiting_id") {
        if (!/^\d+$/.test(text)) {
          await ctx.reply("⛔ ID должен состоять только из цифр. Попробуйте ещё раз:\n\n<i>Или нажмите любую кнопку меню чтобы отменить.</i>", { parse_mode: "HTML" });
          return;
        }
        addUserState[userId] = { step: "awaiting_role", telegramId: text };
        await ctx.reply(
          `Шаг 2 из 3: Выберите роль для сотрудника <code>${text}</code>:`,
          {
            parse_mode: "HTML",
            ...Markup.keyboard([
              ["руководитель", "администратор"],
              ["менеджер", "тестировщик"],
              ["❌ Отмена"],
            ]).resize().oneTime(),
          }
        );
        return;
      }

      // Шаг 2: роль
      if (addSt.step === "awaiting_role") {
        const role = ROLE_ALIASES[text.toLowerCase()];
        if (!role) {
          await ctx.reply("⛔ Выберите роль из кнопок ниже:", {
            ...Markup.keyboard([
              ["руководитель", "администратор"],
              ["менеджер", "тестировщик"],
              ["❌ Отмена"],
            ]).resize().oneTime(),
          });
          return;
        }
        addUserState[userId] = { ...addSt, step: "awaiting_name", role };
        await ctx.reply(
          `Шаг 3 из 3: Введите имя сотрудника\n(или отправьте «-» чтобы пропустить):`,
          Markup.removeKeyboard()
        );
        return;
      }

      // Шаг 3: имя → сохраняем
      if (addSt.step === "awaiting_name") {
        const name = text === "-" ? null : text;
        delete addUserState[userId];
        try {
          db.upsertUser({ telegramId: addSt.telegramId, role: addSt.role, name, addedBy: userId });
          const user = db.getUserByTelegramId(userId);
          await ctx.reply(
            `✅ <b>Сотрудник добавлен</b>\n\n` +
            `Имя: <b>${escapeHtml(name || "не указано")}</b>\n` +
            `Роль: <b>${roleLabel(addSt.role)}</b>\n` +
            `ID: <code>${addSt.telegramId}</code>`,
            { parse_mode: "HTML", ...createMainKeyboard(user?.role) }
          );
        } catch (e) {
          console.error("upsertUser error:", e);
          await ctx.reply("⚠️ Не удалось сохранить сотрудника. Попробуйте ещё раз.");
        }
        return;
      }
    }

    // ════════════════════════════════════════════════════════════
    // ДИАЛОГ: ИЗМЕНЕНИЕ KPI
    // ════════════════════════════════════════════════════════════
    if (kpiSt) {
      // Шаг 1: площадка
      if (kpiSt.step === "kpi_awaiting_platform") {
        const platform = text === "🔵 Ozon" ? "ozon" : text === "🟣 Wildberries" ? "wb" : null;
        if (!platform) {
          await ctx.reply("Выберите площадку из кнопок:", {
            ...Markup.keyboard([["🔵 Ozon", "🟣 Wildberries"], ["❌ Отмена"]]).resize().oneTime(),
          });
          return;
        }
        kpiState[userId] = { step: "kpi_awaiting_field", platform };
        await ctx.reply(
          `Какой показатель изменить для <b>${platform === "ozon" ? "Ozon" : "Wildberries"}</b>?`,
          {
            parse_mode: "HTML",
            ...Markup.keyboard([
              ["💰 Выручка", "📢 Рекл. бюджет"],
              ["🔄 Конверсия", "📦 Заказы в день"],
              ["❌ Отмена"],
            ]).resize().oneTime(),
          }
        );
        return;
      }

      // Шаг 2: поле
      if (kpiSt.step === "kpi_awaiting_field") {
        const fieldMap = {
          "💰 выручка":      "revenue",
          "📢 рекл. бюджет": "ad_budget",
          "🔄 конверсия":    "conversion",
          "📦 заказы в день":"daily_orders",
        };
        const field = fieldMap[text.toLowerCase()];
        if (!field) {
          await ctx.reply("Выберите показатель из кнопок:", {
            ...Markup.keyboard([
              ["💰 Выручка", "📢 Рекл. бюджет"],
              ["🔄 Конверсия", "📦 Заказы в день"],
              ["❌ Отмена"],
            ]).resize().oneTime(),
          });
          return;
        }
        kpiState[userId] = { ...kpiSt, step: "kpi_awaiting_value", field };
        const hint = field === "conversion"
          ? " (например: 3.5)"
          : field === "daily_orders"
          ? " (например: 150)"
          : " (например: 5000000)";
        await ctx.reply(
          `Введите новое значение для <b>${KPI_LABELS[field]}</b>${hint}:`,
          { parse_mode: "HTML", ...Markup.removeKeyboard() }
        );
        return;
      }

      // Шаг 3: значение → сохраняем
      if (kpiSt.step === "kpi_awaiting_value") {
        const value = Number(text.replace(/[^\d.,]/g, "").replace(",", "."));
        if (!Number.isFinite(value) || value <= 0) {
          await ctx.reply("⛔ Введите корректное число больше нуля:");
          return;
        }
        delete kpiState[userId];
        db.setKpiValue(`${kpiSt.platform}_${kpiSt.field}`, value);
        db.setKpiValue(kpiSt.field, value); // обратная совместимость
        const user = db.getUserByTelegramId(userId);
        const emoji = kpiSt.platform === "ozon" ? "🔵" : "🟣";
        const platformLabel = kpiSt.platform === "ozon" ? "Ozon" : "Wildberries";
        await ctx.reply(
          `✅ <b>KPI обновлён</b>\n\n${emoji} ${platformLabel}\n` +
          `${KPI_LABELS[kpiSt.field]}: <b>${value.toLocaleString("ru-RU")}</b>`,
          { parse_mode: "HTML", ...createMainKeyboard(user?.role) }
        );
        return;
      }
    }

    // Неизвестный шаг — сбрасываем оба состояния
    delete addUserState[userId];
    delete kpiState[userId];
    return next();
  });

  // ── Меню Telegram ────────────────────────────────────────────────
  bot.telegram.setMyCommands([
    { command: "start",  description: "🚀 Главное меню" },
    { command: "help",   description: "💬 Список команд" },
    { command: "app",    description: "✈️ Открыть WebApp" },
  ]).catch(() => {});

  // ── /start ───────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    // Сбрасываем любой активный диалог при /start
    const userId = String(ctx.from?.id);
    delete addUserState[userId];
    delete kpiState[userId];

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
    const userId = String(ctx.from?.id);
    delete addUserState[userId];
    delete kpiState[userId];
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    await ctx.reply(formatHelp(user.role), { parse_mode: "HTML" });
  });

  // ── /app ─────────────────────────────────────────────────────────
  bot.command("app", async (ctx) => {
    const userId = String(ctx.from?.id);
    delete addUserState[userId];
    delete kpiState[userId];
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
    const snap = canViewFinance(user.role) || isTester(user.role) ? snapshot : hideFinance(snapshot);
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
    const now   = canViewFinance(user.role) || isTester(user.role) ? snapshotNow  : hideFinance(snapshotNow);
    const prev2 = canViewFinance(user.role) || isTester(user.role) ? snapshotPrev : hideFinance(snapshotPrev);
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

  // ── Настройки KPI (admin + owner + tester — но tester только смотрит) ──
  bot.hears("⚙️ Настройки KPI", async (ctx) => {
    const user = await requireRole(ctx, db, "admin");
    if (!user) return;
    await ctx.reply(formatSettingsMessage(db.getKpiSettings()), { parse_mode: "HTML" });
  });

  // ── Изменить KPI — только admin и owner (не tester) ──────────────
  bot.hears("✏️ Изменить KPI", async (ctx) => {
    const user = await requireKnownUser(ctx, db);
    if (!user) return;
    if (isTester(user.role)) {
      await ctx.reply("ℹ️ В тестовом режиме изменение KPI недоступно.", { parse_mode: "HTML" });
      return;
    }
    if (!hasAccess(user.role, "admin")) {
      await ctx.reply(`⛔ Недостаточно прав. Требуется роль: <b>${roleLabel("admin")}</b>.`, { parse_mode: "HTML" });
      return;
    }
    kpiState[String(ctx.from.id)] = { step: "kpi_awaiting_platform" };
    await ctx.reply(
      "✏️ <b>Изменение KPI</b>\n\nВыберите площадку:",
      {
        parse_mode: "HTML",
        ...Markup.keyboard([
          ["🔵 Ozon", "🟣 Wildberries"],
          ["❌ Отмена"],
        ]).resize().oneTime(),
      }
    );
  });

  // ── /setkpi (admin + owner) ───────────────────────────────────────
  bot.command("setkpi", async (ctx) => {
    const user = await requireRole(ctx, db, "admin");
    if (!user) return;
    if (isTester(user.role)) {
      await ctx.reply("ℹ️ В тестовом режиме изменение KPI недоступно.");
      return;
    }
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
  // УПРАВЛЕНИЕ СОТРУДНИКАМИ — только owner (tester заблокирован)
  // ════════════════════════════════════════════════════════════════

  bot.hears("👤 Добавить сотрудника", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
    if (!user) return;
    const ownerId = String(ctx.from.id);
    addUserState[ownerId] = { step: "awaiting_id" };
    await ctx.reply(
      "👤 <b>Добавление сотрудника</b>\n\n" +
      "Шаг 1 из 3: Отправьте <b>Telegram ID</b> сотрудника.\n\n" +
      "<i>Чтобы узнать свой ID, сотрудник может написать боту @userinfobot</i>\n\n" +
      "Нажмите любую кнопку меню чтобы отменить.",
      { parse_mode: "HTML" }
    );
  });

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
      `❌ <b>Удаление сотрудника</b>\n\nОтправьте <b>Telegram ID</b> сотрудника которого хотите удалить:\n\n${list}\n\nНажмите любую кнопку меню чтобы отменить.`,
      { parse_mode: "HTML" }
    );
    addUserState[String(ctx.from.id)] = { step: "awaiting_remove_id" };
  });

  bot.hears("👥 Список сотрудников", async (ctx) => {
    const user = await requireRole(ctx, db, "owner");
    if (!user) return;
    await ctx.reply(formatUsers(db.listUsers()), { parse_mode: "HTML" });
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
    // При любой ошибке сбрасываем диалог чтобы не застревать
    const userId = String(ctx.from?.id);
    delete addUserState[userId];
    delete kpiState[userId];
    await ctx.reply("⚠️ Ошибка обработки команды. Попробуйте ещё раз.");
    console.error("Bot handler error:", error);
  });
}

module.exports = { registerCommands, isTester };
