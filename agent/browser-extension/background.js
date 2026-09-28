/**
 * Aktif sekme URL'ini yerel agent'a bildirir.
 *
 * GIZLILIK:
 *   - Yalnizca AKTIF sekmenin URL'i ve basligi gonderilir.
 *   - Sayfa icerigi, form verisi, cerez veya tarayici gecmisi OKUNMAZ.
 *   - Hedef yalnizca localhost'tur (127.0.0.1:17873); uzak sunucu yok.
 */

const AGENT_ENDPOINT = "http://127.0.0.1:17873/v1/url";
const MIN_INTERVAL_MS = 4000; // ayni sekme icin en fazla 4 saniyede bir bildirim

let lastSignature = "";
let lastSentAt = 0;

function browserName() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "edge";
  if (ua.includes("OPR/")) return "opera";
  if (ua.includes("Brave")) return "brave";
  if (ua.includes("Firefox")) return "firefox";
  if (ua.includes("Vivaldi")) return "vivaldi";
  return "chrome";
}

/** Agent'a gonderilecek zararli semalari filtrele. */
function isReportable(url) {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

async function report(tab) {
  if (!tab || !isReportable(tab.url)) return;
  const signature = `${tab.url}`;
  const now = Date.now();
  if (signature === lastSignature && now - lastSentAt < MIN_INTERVAL_MS) return;

  lastSignature = signature;
  lastSentAt = now;

  const payload = {
    url: tab.url,
    title: tab.title || "",
    browser: browserName(),
    ts: new Date().toISOString(),
  };

  try {
    await fetch(AGENT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Agent kapali olabilir; sessizce yoksay (kuyruk tutmaya gerek yok,
    // agent pencere basligindan domain tahminiyle devam eder).
  }
}

async function reportActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await report(tab);
  } catch (error) {
    /* yoksay */
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError) report(tab);
  });
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) report(tab);
});

chrome.windows.onFocusChanged.addListener(() => reportActiveTab());

chrome.alarms.create("tt-heartbeat", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tt-heartbeat") reportActiveTab();
});

chrome.runtime.onStartup.addListener(reportActiveTab);
chrome.runtime.onInstalled.addListener(reportActiveTab);
