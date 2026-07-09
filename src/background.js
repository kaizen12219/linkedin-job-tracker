const SHEETS_BRIDGE_BASE_URL = "https://plank-undergo-sandbag.ngrok-free.dev";
const SHEETS_BRIDGE_HEADERS = {
  "ngrok-skip-browser-warning": "true"
};
const SHEETS_BRIDGE_URL = `${SHEETS_BRIDGE_BASE_URL}/jobs`;
const BADGE_TIMEOUT_MS = 4000;

chrome.commands.onCommand.addListener((command, commandTab) => {
  if (command === "scrape-and-save-job") {
    runScrapeAndSaveShortcut(commandTab);
  }
});

async function runScrapeAndSaveShortcut(commandTab) {
  let tab = commandTab || null;

  try {
    await setBadge("...", "#56687a");
    tab = tab?.id ? tab : await getActiveTab();

    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    if (!isSupportedUrl(tab.url || "")) {
      throw new Error("Open a LinkedIn job page before using the shortcut.");
    }

    const scrapeResponse = await requestScrape(tab.id);

    if (!scrapeResponse?.ok) {
      throw new Error(scrapeResponse?.error || "The scraper did not return data.");
    }

    const saveResult = await saveToSheet(scrapeResponse.data);

    if (saveResult.status === "duplicate") {
      await setBadge("SKIP", "#8a6d1d");
      await notify(tab.id, saveResult.message || `${scrapeResponse.data.company} already exists in the sheet.`, "warning");
      return;
    }

    await setBadge("OK", "#1f7a3f");
    await notify(tab.id, `Saved ${scrapeResponse.data.company || "job"} to Google Sheets.`, "success");
  } catch (error) {
    await setBadge("ERR", "#b3261e");
    await notify(tab?.id, error.message, "error");
  } finally {
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "" });
    }, BADGE_TIMEOUT_MS);
  }
}

async function getActiveTab() {
  const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (focusedTabs[0]) {
    return focusedTabs[0];
  }

  const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return currentTabs[0] || null;
}

async function requestScrape(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_LINKEDIN_JOB" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/scraper.js", "src/content.js"]
    });

    return chrome.tabs.sendMessage(tabId, { type: "SCRAPE_LINKEDIN_JOB" });
  }
}

async function saveToSheet(payload) {
  const targetSheetGid = await getSelectedSheetGid();
  const response = await fetch(SHEETS_BRIDGE_URL, {
    method: "POST",
    headers: {
      ...SHEETS_BRIDGE_HEADERS,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...payload,
      ...(targetSheetGid ? { targetSheetGid } : {})
    })
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Sheets bridge returned HTTP ${response.status}.`);
  }

  return result;
}

async function getSelectedSheetGid() {
  const result = await chrome.storage.local.get("selectedSheetGid");
  return result.selectedSheetGid || "";
}

function isSupportedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("linkedin.com") && parsed.pathname.startsWith("/jobs");
  } catch (error) {
    return false;
  }
}

async function notify(tabId, message, tone = "info") {
  await chrome.action.setTitle({ title: `LinkedIn Job Scraper: ${message}` });

  if (!tabId) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showShortcutToast,
      args: [message, tone]
    });
  } catch (error) {
    // Some pages do not allow script injection; the badge/title still carry the result.
  }
}

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

function showShortcutToast(message, tone) {
  const existing = document.querySelector("[data-linkedin-job-scraper-toast]");

  if (existing) {
    existing.remove();
  }

  const toast = document.createElement("div");
  const palette = {
    success: "#1f7a3f",
    warning: "#8a6d1d",
    error: "#b3261e",
    info: "#56687a"
  };

  toast.dataset.linkedinJobScraperToast = "true";
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    zIndex: "2147483647",
    right: "18px",
    bottom: "18px",
    maxWidth: "360px",
    padding: "12px 14px",
    borderRadius: "8px",
    background: palette[tone] || palette.info,
    color: "#ffffff",
    font: "13px/1.4 Arial, Helvetica, sans-serif",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.22)"
  });
  document.documentElement.append(toast);

  setTimeout(() => {
    toast.remove();
  }, 5000);
}
