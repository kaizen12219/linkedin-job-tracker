importScripts("tracker-security.js", "kai-flow-client.js");

const kaiFlowClient = KaiFlowTrackerClient.create({
  onChange: () => {
    // No token or pairing code is exposed to runtime messages.
    chrome.runtime.sendMessage?.({ type: "KAI_TRACKER_QUEUE_CHANGED" })?.catch(() => {});
  }
});
const PROFILE_STORAGE_KEY = "kaiFlowSelectedProfile";
const BADGE_TIMEOUT_MS = 4000;
const TRACKER_MESSAGES = new Set(["KAI_TRACKER_OPTIONS", "KAI_TRACKER_DUPLICATE", "KAI_TRACKER_SAVE", "KAI_TRACKER_PAIR", "KAI_TRACKER_STATUS", "KAI_TRACKER_CANCEL", "KAI_TRACKER_RETRY"]);
const RETRY_ALARM = "kai-flow-remote-queue";

async function resumeQueue() {
  try {
    await kaiFlowClient.init();
    await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 0.5 });
    await kaiFlowClient.flushQueue();
  } catch {
    // Popup reports connection/storage failures. Never discard a failed queue.
    await chrome.action.setBadgeText({ text: "!" });
  }
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === RETRY_ALARM) void resumeQueue(); });
chrome.runtime.onStartup.addListener(() => void resumeQueue());
chrome.runtime.onInstalled.addListener(() => void resumeQueue());
void resumeQueue();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!TRACKER_MESSAGES.has(message?.type)) return undefined;

  // Only our popup can request writes. LinkedIn content scripts are not trusted callers.
  if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("popup.html")) {
    sendResponse({ ok: false, error: { code: "TRACKER_FORBIDDEN", message: "Open the tracker popup to save a job." } });
    return false;
  }

  handleTrackerMessage(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: {
      code: error.code || "KAI_FLOW_REQUEST_FAILED",
      message: error.message || "Kai Flow could not complete the request.",
      ...(error.details !== undefined ? { details: error.details } : {})
    } })
  );
  return true;
});

async function handleTrackerMessage(message) {
  if (message.type === "KAI_TRACKER_PAIR") return kaiFlowClient.pair(message.link, message.deviceName);
  if (message.type === "KAI_TRACKER_STATUS") return kaiFlowClient.getStatus();
  if (message.type === "KAI_TRACKER_CANCEL") return kaiFlowClient.cancel(message.requestId);
  if (message.type === "KAI_TRACKER_RETRY") { await kaiFlowClient.flushQueue(); return kaiFlowClient.getStatus(); }
  if (message.type === "KAI_TRACKER_OPTIONS") return kaiFlowClient.getOptions({ refresh: message.refresh === true });
  if (message.type === "KAI_TRACKER_DUPLICATE") return kaiFlowClient.lookupDuplicate(message.company);
  return kaiFlowClient.saveJob(message.job, { profile: message.profile ?? "" });
}

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

    const savedSettings = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    const profile = savedSettings[PROFILE_STORAGE_KEY] ?? "";
    const result = await kaiFlowClient.saveJob(scrapeResponse.data, { profile });
    if (result.status === "inserted") {
      await setBadge("OK", "#1f7a3f");
      await notify(tab.id, `Saved ${scrapeResponse.data.company || "job"} to Kai Flow.`, "success");
    } else {
      await setBadge("WAIT", "#8a6d1d");
      await notify(tab.id, result.state === "review" || result.status === "canceled" ? "An earlier save needs attention. Open the tracker queue; no new request was created." : "Job queued. The tracker will retry automatically while this browser is running.", "warning");
    }
  } catch (error) {
    if (error.code === "DUPLICATE_COMPANY") {
      const duplicate = error.details?.duplicate;
      const brief = duplicate ? `${duplicate.company} — ${duplicate.jobTitle}` : "This company";
      await setBadge("DUP", "#8a6d1d");
      await notify(tab?.id, `${brief} already exists in Kai Flow. Open the tracker to view the matching job.`, "warning");
    } else {
      await setBadge("ERR", "#b3261e");
      await notify(tab?.id, error.message, "error");
    }
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

function isSupportedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "linkedin.com" || parsed.hostname.endsWith(".linkedin.com")) && parsed.pathname.startsWith("/jobs");
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
