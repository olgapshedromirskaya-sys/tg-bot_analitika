require("dotenv").config();

const { Telegraf } = require("telegraf");
const { registerCommands } = require("./bot/commands");
const { initDatabase } = require("./db/database");
const { startScheduler } = require("./scheduler");
const { startWebAppServer } = require("./webapp/server");

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function bootstrap() {
  const botToken = getRequiredEnv("BOT_TOKEN");
  const db = initDatabase();
  db.ensureOwner(process.env.OWNER_TELEGRAM_ID);

  const bot = new Telegraf(botToken);
  registerCommands(bot, db);
  const webAppServer = startWebAppServer({ db });

  const schedulerEnabled =
    String(process.env.DISABLE_SCHEDULER || "false").toLowerCase() !== "true";
  const scheduler = schedulerEnabled ? startScheduler({ bot, db }) : null;

  await bot.launch();
  console.log("✅ Bot launched");

  const stop = (signal) => {
    console.log(`Received ${signal}, stopping bot...`);
    scheduler?.stop();
    webAppServer.stop();
    bot.stop(signal);
    db.close();
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

bootstrap().catch((error) => {
  console.error("❌ Failed to start bot:", error);
  process.exit(1);
});
