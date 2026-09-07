importScripts("google-sheets-client.js", "banned-companies.js");

const sheetClient = GoogleSheetsTrackerClient.create();
const bannedCompanies = KaiFlowBannedCompanies.create();
const PROFILE_STORAGE_KEY = "kaiFlowSelectedProfile";
const BADGE_TIMEOUT_MS = 4000;
const COMPANY_SNAPSHOT_STORAGE_KEY = "kaiFlowCompanySnapshotV1";
const COMPANY_SNAPSHOT_REFRESH_MS = 30_000;
const MAX_SNAPSHOT_COMPANIES = 20_000;
let companySnapshotNames = [];
let companySnapshotKeys = new Set();
let companySnapshotRevision = "";
let companySnapshotUpdatedAt = 0;
let companySnapshotAvailable = false;
let companySnapshotLoad = null;
let companySnapshotRefresh = null;
let companySnapshotLastAttemptAt = 0;
let companySnapshotGeneration = 0;
let companySnapshotNeedsRefresh = false;
const POPUP_MESSAGES = new Set([
  "KAI_TRACKER_OPTIONS",
  "KAI_TRACKER_DUPLICATE",
  "KAI_TRACKER_SAVE",
  "KAI_TRACKER_CONFIGURE",
  "KAI_TRACKER_CLEAR_CONFIG",
  "KAI_TRACKER_STATUS",
  "KAI_TRACKER_BANNED_GET",
  "KAI_TRACKER_BANNED_SET"
]);

async function initialize() {
  try {
    await Promise.all([sheetClient.init(), bannedCompanies.list(), loadCompanySnapshot()]);
    const status = await sheetClient.getStatus();
    if (!status.configured) {
      await clearCompanySnapshot();
      return;
    }
    try {
      const changed = await refreshCompanySnapshot({ force: true });
      if (changed) await refreshLinkedInStyles();
    } catch {
      // A last-known snapshot remains useful while Google is briefly unreachable.
    }
  } catch {
    await chrome.action.setBadgeText({ text: "!" });
  }
}

chrome.runtime.onStartup.addListener(() => void initialize());
chrome.runtime.onInstalled.addListener(() => void initialize());
void initialize();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const popupMessage = POPUP_MESSAGES.has(message?.type);
  const classifyMessage = message?.type === "KAI_TRACKER_CLASSIFY_COMPANIES";
  if (!popupMessage && !classifyMessage) return undefined;

  if (popupMessage && !isPopupSender(sender)) {
    sendResponse({ ok: false, error: { code: "TRACKER_FORBIDDEN", message: "Open the tracker popup to change or save data." } });
    return false;
  }
  if (classifyMessage && !isLinkedInSender(sender)) {
    sendResponse({ ok: false, error: { code: "TRACKER_FORBIDDEN", message: "Job highlighting is available only on LinkedIn job pages." } });
    return false;
  }

  handleTrackerMessage(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: {
      code: error.code || "TRACKER_REQUEST_FAILED",
      message: error.message || "The tracker could not complete the request.",
      ...(error.details !== undefined ? { details: error.details } : {})
    } })
  );
  return true;
});

function isPopupSender(sender) {
  return sender?.id === chrome.runtime.id && sender?.url === chrome.runtime.getURL("popup.html");
}

function isLinkedInSender(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(sender.url || "");
    return url.protocol === "https:" &&
      (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) &&
      url.pathname.startsWith("/jobs");
  } catch {
    return false;
  }
}

async function handleTrackerMessage(message) {
  if (message.type === "KAI_TRACKER_CONFIGURE") {
    const result = await sheetClient.configure({
      credentials: message.credentials,
      sheetUrl: message.sheetUrl,
      sheetGid: message.sheetGid
    });
    await clearCompanySnapshot();
    try { await refreshCompanySnapshot({ force: true }); } catch { /* Valid settings remain useful if the refresh races. */ }
    await refreshLinkedInStyles();
    return result;
  }
  if (message.type === "KAI_TRACKER_CLEAR_CONFIG") {
    const result = await sheetClient.clearConfiguration();
    await clearCompanySnapshot();
    await refreshLinkedInStyles();
    return result;
  }
  if (message.type === "KAI_TRACKER_STATUS") return sheetClient.getStatus();
  if (message.type === "KAI_TRACKER_OPTIONS") return sheetClient.getOptions({ refresh: message.refresh === true });
  if (message.type === "KAI_TRACKER_DUPLICATE") return sheetClient.lookupDuplicate(message.company);
  if (message.type === "KAI_TRACKER_BANNED_GET") return { companies: await bannedCompanies.list() };
  if (message.type === "KAI_TRACKER_BANNED_SET") {
    const companies = await bannedCompanies.set(message.companies);
    await refreshLinkedInStyles();
    return { companies };
  }
  if (message.type === "KAI_TRACKER_CLASSIFY_COMPANIES") {
    return classifyCompanies(message.companies, { refresh: message.refresh === true });
  }

  if (await bannedCompanies.has(message.job?.company)) {
    const failure = new Error("This company is in the tracker’s banned-company list. Nothing was added.");
    failure.code = "BANNED_COMPANY";
    throw failure;
  }
  const result = await sheetClient.saveJob(message.job, { profile: message.profile ?? "" });
  try { await rememberTrackedCompany(message.job?.company); } catch { /* A cache write must never turn a confirmed save into a failure. */ }
  await refreshLinkedInStyles();
  void refreshSnapshotAndStyles({ force: true });
  return result;
}

async function classifyCompanies(values, { refresh = false } = {}) {
  const companies = KaiFlowBannedCompanies.sanitize(Array.isArray(values) ? values.slice(0, 100) : []);
  const banned = new Set((await bannedCompanies.list()).map(KaiFlowBannedCompanies.key));
  await loadCompanySnapshot();

  if (refresh) {
    try {
      const changed = await refreshCompanySnapshot({ force: true });
      if (changed) void refreshLinkedInStyles();
    } catch {
      // Keep classifying from the last complete Sheet snapshot when offline.
    }
  } else if (!companySnapshotAvailable) {
    try { await refreshCompanySnapshot({ force: true }); } catch { /* Handled below. */ }
  } else if (Date.now() - companySnapshotUpdatedAt >= COMPANY_SNAPSHOT_REFRESH_MS) {
    void refreshSnapshotAndStyles();
  }

  if (!companySnapshotAvailable) {
    const failure = new Error("The Google Sheet company list is not available yet.");
    failure.code = "TRACKER_SNAPSHOT_UNAVAILABLE";
    throw failure;
  }

  return { companies: companies.map((company) => {
    const normalized = KaiFlowBannedCompanies.key(company);
    const isBanned = banned.has(normalized);
    return {
      company,
      banned: isBanned,
      duplicate: !isBanned && companySnapshotKeys.has(normalized) ? { company } : null
    };
  }) };
}

async function loadCompanySnapshot() {
  if (!companySnapshotLoad) companySnapshotLoad = (async () => {
    const saved = (await chrome.storage.local.get(COMPANY_SNAPSHOT_STORAGE_KEY))?.[COMPANY_SNAPSHOT_STORAGE_KEY];
    try {
      if (!saved || saved.version !== 1 || !Array.isArray(saved.companies) ||
        typeof saved.revision !== "string" || !Number.isFinite(saved.updatedAt)) return;
      const names = sanitizeSnapshotCompanies(saved.companies);
      setCompanySnapshot(names, saved.revision, saved.updatedAt);
    } catch {
      // Corrupt or legacy cache data is ignored and replaced by the next full sync.
    }
  })();
  return companySnapshotLoad;
}

function sanitizeSnapshotCompanies(values) {
  if (!Array.isArray(values) || values.length > MAX_SNAPSHOT_COMPANIES) throw new Error("Invalid company snapshot.");
  const names = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") throw new Error("Invalid company snapshot.");
    const name = KaiFlowBannedCompanies.normalize(value);
    const key = KaiFlowBannedCompanies.key(name);
    if (!name || name.length > 1000) throw new Error("Invalid company snapshot.");
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function setCompanySnapshot(names, revision, updatedAt = Date.now()) {
  companySnapshotNames = names;
  companySnapshotKeys = new Set(names.map(KaiFlowBannedCompanies.key));
  companySnapshotRevision = revision;
  companySnapshotUpdatedAt = updatedAt;
  companySnapshotAvailable = true;
  companySnapshotNeedsRefresh = false;
}

async function persistCompanySnapshot() {
  await chrome.storage.local.set({
    [COMPANY_SNAPSHOT_STORAGE_KEY]: {
      version: 1,
      companies: companySnapshotNames,
      revision: companySnapshotRevision,
      updatedAt: companySnapshotUpdatedAt
    }
  });
}

async function clearCompanySnapshot() {
  await loadCompanySnapshot();
  companySnapshotNames = [];
  companySnapshotKeys = new Set();
  companySnapshotRevision = "";
  companySnapshotUpdatedAt = 0;
  companySnapshotAvailable = false;
  companySnapshotGeneration += 1;
  companySnapshotNeedsRefresh = false;
  await chrome.storage.local.set({ [COMPANY_SNAPSHOT_STORAGE_KEY]: null });
}

async function refreshCompanySnapshot({ force = false } = {}) {
  await loadCompanySnapshot();
  if (companySnapshotRefresh) return companySnapshotRefresh;
  const now = Date.now();
  if (!force && companySnapshotAvailable && now - companySnapshotUpdatedAt < COMPANY_SNAPSHOT_REFRESH_MS) return false;
  if (!force && now - companySnapshotLastAttemptAt < 5000) return false;
  companySnapshotLastAttemptAt = now;
  const startingGeneration = companySnapshotGeneration;

  companySnapshotRefresh = (async () => {
    const result = await sheetClient.getCompanies({
      refresh: force,
      revision: companySnapshotAvailable ? companySnapshotRevision : ""
    });
    if (startingGeneration !== companySnapshotGeneration) return false;
    if (result.unchanged) {
      if (!companySnapshotAvailable || result.revision !== companySnapshotRevision) {
        const failure = new Error("The Google Sheet returned an unmatched company revision.");
        failure.code = "TRACKER_PROTOCOL_ERROR";
        throw failure;
      }
      companySnapshotUpdatedAt = Date.now();
      await persistCompanySnapshot();
      return false;
    }

    const names = sanitizeSnapshotCompanies(result.companies);
    const nextKeys = new Set(names.map(KaiFlowBannedCompanies.key));
    const changed = result.revision !== companySnapshotRevision || names.length !== companySnapshotNames.length ||
      names.some((name) => !companySnapshotKeys.has(KaiFlowBannedCompanies.key(name))) ||
      companySnapshotNames.some((name) => !nextKeys.has(KaiFlowBannedCompanies.key(name)));
    setCompanySnapshot(names, result.revision);
    await persistCompanySnapshot();
    return changed;
  })();

  try {
    return await companySnapshotRefresh;
  } finally {
    companySnapshotRefresh = null;
  }
}

async function rememberTrackedCompany(company) {
  await loadCompanySnapshot();
  const name = KaiFlowBannedCompanies.normalize(company);
  const key = KaiFlowBannedCompanies.key(name);
  if (!name || companySnapshotKeys.has(key)) return;
  const hadCompleteSnapshot = companySnapshotAvailable;
  companySnapshotNames = sanitizeSnapshotCompanies([...companySnapshotNames, name]);
  companySnapshotKeys.add(key);
  companySnapshotRevision = "";
  companySnapshotUpdatedAt = hadCompleteSnapshot ? Date.now() : 0;
  companySnapshotGeneration += 1;
  companySnapshotNeedsRefresh = true;
  if (hadCompleteSnapshot) await persistCompanySnapshot();
}

async function refreshSnapshotAndStyles(options = {}) {
  try {
    let changed = await refreshCompanySnapshot(options);
    if (options.force && companySnapshotNeedsRefresh) {
      changed = await refreshCompanySnapshot({ force: true }) || changed;
    }
    if (changed) await refreshLinkedInStyles();
  } catch {
    // Cached styling remains stable while a refresh is unavailable.
  }
}

async function refreshLinkedInStyles() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["https://linkedin.com/jobs/*", "https://*.linkedin.com/jobs/*"] });
  } catch {
    return;
  }
  await Promise.allSettled(tabs.filter((tab) => tab.id).map((tab) => (
    chrome.tabs.sendMessage(tab.id, { type: "KAI_TRACKER_REFRESH_STYLES" })
  )));
}

chrome.commands.onCommand.addListener((command, commandTab) => {
  if (command === "scrape-and-save-job") void runScrapeAndSaveShortcut(commandTab);
});

async function runScrapeAndSaveShortcut(commandTab) {
  let tab = commandTab || null;
  try {
    await setBadge("...", "#56687a");
    tab = tab?.id ? tab : await getActiveTab();
    if (!tab?.id) throw new Error("No active tab found.");
    if (!isSupportedUrl(tab.url || "")) throw new Error("Open a LinkedIn job page before using the shortcut.");

    const scrapeResponse = await requestScrape(tab.id);
    if (!scrapeResponse?.ok) throw new Error(scrapeResponse?.error || "The scraper did not return data.");
    if (await bannedCompanies.has(scrapeResponse.data.company)) {
      const failure = new Error("This company is in the tracker’s banned-company list. Nothing was added.");
      failure.code = "BANNED_COMPANY";
      throw failure;
    }

    const savedSettings = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    const profile = savedSettings[PROFILE_STORAGE_KEY] ?? "";
    await sheetClient.saveJob(scrapeResponse.data, { profile });
    try { await rememberTrackedCompany(scrapeResponse.data.company); } catch { /* The confirmed save still succeeds. */ }
    await refreshLinkedInStyles();
    void refreshSnapshotAndStyles({ force: true });
    await setBadge("OK", "#1f7a3f");
    await notify(tab.id, `Saved ${scrapeResponse.data.company || "job"} to Google Sheets.`, "success");
  } catch (error) {
    if (error.code === "DUPLICATE_COMPANY") {
      const duplicate = error.details?.duplicate;
      const brief = duplicate ? `${duplicate.company} — ${duplicate.jobTitle}` : "This company";
      await setBadge("DUP", "#8a6d1d");
      await notify(tab?.id, `${brief} already exists in the Google Sheet.`, "warning");
    } else if (error.code === "BANNED_COMPANY") {
      await setBadge("BAN", "#b3261e");
      await notify(tab?.id, error.message, "warning");
    } else {
      await setBadge("ERR", "#b3261e");
      await notify(tab?.id, error.message, "error");
    }
  } finally {
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), BADGE_TIMEOUT_MS);
  }
}

async function getActiveTab() {
  const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focusedTabs[0]) return focusedTabs[0];
  const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return currentTabs[0] || null;
}

async function requestScrape(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_LINKEDIN_JOB" });
  } catch {
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
    return parsed.protocol === "https:" &&
      (parsed.hostname === "linkedin.com" || parsed.hostname.endsWith(".linkedin.com")) &&
      parsed.pathname.startsWith("/jobs");
  } catch {
    return false;
  }
}

async function notify(tabId, message, tone = "info") {
  await chrome.action.setTitle({ title: `LinkedIn Job Scraper: ${message}` });
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showShortcutToast, args: [message, tone] });
  } catch {
    // The badge/title still carry the result on pages that reject injection.
  }
}

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

function showShortcutToast(message, tone) {
  document.querySelector("[data-linkedin-job-scraper-toast]")?.remove();
  const toast = document.createElement("div");
  const palette = { success: "#1f7a3f", warning: "#8a6d1d", error: "#b3261e", info: "#56687a" };
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
  setTimeout(() => toast.remove(), 5000);
}
