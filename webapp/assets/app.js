(function bootstrapTelegramWebApp() {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!tg) {
    return;
  }

  try {
    tg.ready();
    tg.expand();
    tg.setBackgroundColor("#05060e");
    tg.setHeaderColor("#05060e");
  } catch (error) {
    // Some Telegram clients ignore theme methods, which is acceptable.
  }
})();

const elements = {
  apiStatusLabel: document.getElementById("apiStatusLabel"),
  channelsLabel: document.getElementById("channelsLabel"),
  heroSubtitle: document.getElementById("heroSubtitle"),
  todayRevenue: document.getElementById("todayRevenue"),
  todayRevenueDelta: document.getElementById("todayRevenueDelta"),
  todayOrders: document.getElementById("todayOrders"),
  todayOrdersDelta: document.getElementById("todayOrdersDelta"),
  todayAdSpend: document.getElementById("todayAdSpend"),
  todayAdSpendDelta: document.getElementById("todayAdSpendDelta"),
  todayConversion: document.getElementById("todayConversion"),
  todayConversionDelta: document.getElementById("todayConversionDelta"),
  riskAlertTitle: document.getElementById("riskAlertTitle"),
  riskAlertMessage: document.getElementById("riskAlertMessage"),
  monthRevenueLabel: document.getElementById("monthRevenueLabel"),
  monthAdBudgetLabel: document.getElementById("monthAdBudgetLabel"),
  monthOrdersLabel: document.getElementById("monthOrdersLabel"),
  monthRevenueProgress: document.getElementById("monthRevenueProgress"),
  monthAdBudgetProgress: document.getElementById("monthAdBudgetProgress"),
  monthOrdersProgress: document.getElementById("monthOrdersProgress"),
  impactMetricTime: document.getElementById("impactMetricTime"),
  impactHoursSaved: document.getElementById("impactHoursSaved"),
  impactProfitGrowth: document.getElementById("impactProfitGrowth"),
  impactAdLossReduction: document.getElementById("impactAdLossReduction"),
  ctaLink: document.getElementById("ctaLink"),
  updatedAt: document.getElementById("updatedAt"),
};

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function compactRub(value) {
  const amount = toNumber(value, 0);
  const abs = Math.abs(amount);

  if (abs >= 1_000_000) {
    return `₽${(amount / 1_000_000).toFixed(1)}M`;
  }

  if (abs >= 1_000) {
    return `₽${Math.round(amount / 1_000)}K`;
  }

  return `₽${Math.round(amount)}`;
}

function fullRub(value) {
  return `₽${Math.round(toNumber(value, 0)).toLocaleString("ru-RU")}`;
}

function signed(value, precision) {
  const amount = toNumber(value, 0);
  const rounded = amount.toFixed(precision);
  return `${amount >= 0 ? "+" : ""}${rounded}`;
}

function setProgress(element, progress) {
  const safe = Math.max(0, Math.min(1, toNumber(progress, 0)));
  element.style.width = `${safe * 100}%`;
}

function applyDeltaColor(element, value) {
  const numeric = toNumber(value, 0);
  element.classList.remove("metric-green", "metric-orange");
  element.classList.add(numeric >= 0 ? "metric-green" : "metric-orange");
}

function renderDashboard(data) {
  elements.apiStatusLabel.textContent = data.status.apiIntegrationLabel;
  elements.channelsLabel.textContent = data.status.channelsLabel;
  elements.heroSubtitle.textContent = data.hero.subtitle;

  elements.todayRevenue.textContent = compactRub(data.today.revenue);
  elements.todayRevenueDelta.textContent = `${
    toNumber(data.today.revenueDeltaGoalPercent, 0) >= 0 ? "▲" : "▼"
  } ${signed(data.today.revenueDeltaGoalPercent, 0)}% к цели`;
  applyDeltaColor(elements.todayRevenueDelta, data.today.revenueDeltaGoalPercent);

  elements.todayOrders.textContent = Math.round(toNumber(data.today.orders, 0)).toLocaleString("ru-RU");
  elements.todayOrdersDelta.textContent = `${toNumber(data.today.ordersDeltaYesterday, 0) >= 0 ? "▲" : "▼"} ${
    signed(data.today.ordersDeltaYesterday, 0)
  } от вчера`;
  applyDeltaColor(elements.todayOrdersDelta, data.today.ordersDeltaYesterday);

  elements.todayAdSpend.textContent = compactRub(data.today.adSpend);
  elements.todayAdSpendDelta.textContent = `⚠ ${Math.round(
    toNumber(data.today.adBudgetUsagePercent, 0),
  )}% бюджета`;

  elements.todayConversion.textContent = `${toNumber(data.today.conversion, 0).toFixed(1)}%`;
  elements.todayConversionDelta.textContent = `${
    toNumber(data.today.conversionDeltaYesterday, 0) >= 0 ? "▲" : "▼"
  } ${signed(data.today.conversionDeltaYesterday, 1)}%`;
  applyDeltaColor(elements.todayConversionDelta, data.today.conversionDeltaYesterday);

  elements.riskAlertTitle.textContent = data.riskAlert.title;
  elements.riskAlertMessage.textContent = data.riskAlert.message;

  elements.monthRevenueLabel.textContent = `${fullRub(data.month.revenue.value)} / ${fullRub(
    data.month.revenue.plan,
  )}`;
  elements.monthAdBudgetLabel.textContent = `${fullRub(data.month.adBudget.value)} / ${fullRub(
    data.month.adBudget.plan,
  )}`;
  elements.monthOrdersLabel.textContent = `${Math.round(toNumber(data.month.orders.value, 0)).toLocaleString(
    "ru-RU",
  )} / ${Math.round(toNumber(data.month.orders.plan, 0)).toLocaleString("ru-RU")}`;

  setProgress(elements.monthRevenueProgress, data.month.revenue.progress);
  setProgress(elements.monthAdBudgetProgress, data.month.adBudget.progress);
  setProgress(elements.monthOrdersProgress, data.month.orders.progress);

  elements.impactMetricTime.textContent = `${Math.round(data.impact.metricViewTimeSec)}с`;
  elements.impactHoursSaved.textContent = `${Math.round(data.impact.hoursSavedMonthly)}ч`;
  elements.impactProfitGrowth.textContent = `${signed(data.impact.profitGrowthPercent, 0)}%`;
  elements.impactAdLossReduction.textContent = `${signed(data.impact.adLossReductionPercent, 0)}%`;

  if (data.ctaUrl) {
    elements.ctaLink.href = data.ctaUrl;
  }

  elements.updatedAt.textContent = `Обновлено: ${new Date(data.generatedAt).toLocaleString("ru-RU")}`;
}

async function fetchDashboard() {
  const response = await fetch("/api/webapp/dashboard", {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function refreshDashboard() {
  try {
    const payload = await fetchDashboard();
    renderDashboard(payload);
  } catch (error) {
    elements.updatedAt.textContent = "Ошибка загрузки данных. Повторим попытку автоматически.";
  }
}

refreshDashboard();
setInterval(refreshDashboard, 60_000);
