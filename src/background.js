const SHEETS_BRIDGE_URL = "http://127.0.0.1:8787/jobs";
const BADGE_TIMEOUT_MS = 4000;

chrome.commands.onCommand.addListener((command) => {
  if (command === "scrape-and-save-job") {
    runScrapeAndSaveShortcut();
  }
});

async function runScrapeAndSaveShortcut() {
  try {
    await setBadge("...", "#56687a");
    const tab = await getActiveTab();

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
      await notify(saveResult.message || `${scrapeResponse.data.company} already exists in the sheet.`);
      return;
    }

    await setBadge("OK", "#1f7a3f");
    await notify(`Saved ${scrapeResponse.data.company || "job"} to Google Sheets.`);
  } catch (error) {
    await setBadge("ERR", "#b3261e");
    await notify(error.message);
  } finally {
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "" });
    }, BADGE_TIMEOUT_MS);
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
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
  const response = await fetch(SHEETS_BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Sheets bridge returned HTTP ${response.status}.`);
  }

  return result;
}

function isSupportedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("linkedin.com") && parsed.pathname.startsWith("/jobs");
  } catch (error) {
    return false;
  }
}

async function notify(message) {
  await chrome.action.setTitle({ title: `LinkedIn Job Scraper: ${message}` });
}

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}
