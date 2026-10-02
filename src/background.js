importScripts("kai-local-store-client.js", "banned-companies.js", "capture-policy.js", "research-client.js", "job-collector.js");

const sheetClient = KaiLocalStoreClient.create();
const bannedCompanies = KaiFlowBannedCompanies.create();
const researchClient = JobResearchClient.create({ sheetClient, bannedCompanies,
  onSaved: async (company) => {
    try { await rememberTrackedCompany(company); } catch { /* Confirmed Sheet writes remain successful. */ }
    await refreshLinkedInStyles();
    void refreshSnapshotAndStyles({ force: true });
  },
  onOutcome: async (record, message, result) => notify(record.tabId, message,
    result ? "success" : record.state === "failed" || record.state === "save-unconfirmed" ? "error" : "info", record.job)
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === JobResearchClient.ALARM) void researchClient.poll().catch(() => {});
});
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
const COLLECTION_STORAGE_KEY = "jobTrackerCollectionV1";
let collectionQueue = Promise.resolve();
const collectionWaits = new Map();
const COLLECTION_MESSAGES = new Set(["KAI_TRACKER_RUN_STATE", "KAI_TRACKER_RUN_CHECKPOINT", "KAI_TRACKER_RUN_END", "KAI_TRACKER_RUN_WAIT"]);
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
    await withCollectionState(async (state, save) => {
      if (!state) return;
      try {
        const tab = await chrome.tabs.get(state.tabId);
        if (LinkedInJobCollector.searchKey(tab.url) !== state.searchKey) { await save(null); return; }
        await chrome.tabs.update(state.tabId, { autoDiscardable: false });
      } catch { await save(null); }
    });
    void researchClient.poll().catch(() => {});
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
  const captureMessage = message?.type === "KAI_TRACKER_CAPTURE";
  const collectionMessage = COLLECTION_MESSAGES.has(message?.type);
  if (!popupMessage && !classifyMessage && !captureMessage && !collectionMessage) return undefined;

  if (popupMessage && !isPopupSender(sender)) {
    sendResponse({ ok: false, error: { code: "TRACKER_FORBIDDEN", message: "Open the tracker popup to change or save data." } });
    return false;
  }
  if ((classifyMessage || captureMessage || collectionMessage) && !isLinkedInSender(sender)) {
    sendResponse({ ok: false, error: { code: "TRACKER_FORBIDDEN", message: "Job highlighting is available only on LinkedIn job pages." } });
    return false;
  }

  handleTrackerMessage(message, sender).then(
    (result) => {
      sendResponse({ ok: true, result });
      if (captureMessage && !message.runId) void notify(sender.tab?.id, result.status === "researching"
        ? "Job research started. This job will be added only if it qualifies."
        : result.status === "skipped" ? result.reason : `Saved ${message.job.company} to Kai Flows.`, result.status === "inserted" ? "success" : "info").catch(() => {});
    },
    (error) => {
      sendResponse({ ok: false, error: {
      code: error.code || "TRACKER_REQUEST_FAILED",
      message: error.message || "The tracker could not complete the request.",
      ...(error.details !== undefined ? { details: error.details } : {})
      } });
      if (captureMessage && !message.runId) void notify(sender.tab?.id, error.message, "error").catch(() => {});
    }
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

async function handleTrackerMessage(message, sender = {}) {
  if (message.type === "KAI_TRACKER_RUN_WAIT") return waitForCollectionRun(message, sender);
  if (COLLECTION_MESSAGES.has(message.type)) return handleCollectionMessage(message, sender);
  if (message.type === "KAI_TRACKER_CONFIGURE") {
    await stopActiveCollection();
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
    await stopActiveCollection();
    await researchClient.clear();
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

  let profile = message.profile ?? "";
  if (message.type === "KAI_TRACKER_CAPTURE") {
    const settings = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    profile = settings[PROFILE_STORAGE_KEY] ?? "";
  }
  if (message.runId) {
    const claimed = await withCollectionState(async (state, save) => {
      if (!collectionMatches(state, sender, message.runId)) throw Object.assign(new Error("Job collection stopped. Nothing was added."), { code: "TRACKER_RUN_STOPPED" });
      const jobId = String(message.job?.jobId || "");
      if (!/^\d+$/u.test(jobId) || message.job.jobIdSource === "query" ||
        LinkedInJobCollector.searchKey(message.job.sourceUrl) !== state.searchKey) throw new Error("The selected job could not be verified for this search.");
      if (state.visited.includes(jobId)) return false;
      // Persist before the Sheet/research request, so a reload or lost response
      // cannot replay an uncertain save from this run.
      state.visited.push(jobId);
      await save(state);
      return true;
    });
    if (!claimed) return { status: "skipped", reason: "This job was already processed in this run." };
  }
  const result = await captureJob(message.job, { profile, tabId: sender.tab?.id });
  if (message.runId) await withCollectionState(async (state, save) => {
    if (!collectionMatches(state, sender, message.runId)) return;
    const field = result.status === "inserted" ? "saved" : result.status === "researching" ? "researching" : "skipped";
    state.counts[field]++;
    await save(state);
  });
  return result;
}

function withCollectionState(action) {
  const operation = collectionQueue.catch(() => {}).then(async () => {
    const storage = chrome.storage.session;
    if (!storage) throw new Error("Session storage is unavailable. Reload the extension.");
    const state = (await storage.get(COLLECTION_STORAGE_KEY))[COLLECTION_STORAGE_KEY] || null;
    return action(state, async (value) => {
      await storage.set({ [COLLECTION_STORAGE_KEY]: value });
      if (state && state.id !== value?.id) {
        const wait = collectionWaits.get(state.id);
        if (wait) { clearTimeout(wait.timer); collectionWaits.delete(state.id); wait.resolve({ stopped: true }); }
        if (typeof state.originalAutoDiscardable === "boolean") {
          try { await chrome.tabs.update(state.tabId, { autoDiscardable: state.originalAutoDiscardable }); }
          catch { /* Closed tabs need no restoration. */ }
        }
      }
    });
  });
  collectionQueue = operation.catch(() => {});
  return operation;
}
function collectionMatches(state, sender, id = state?.id) {
  return !!state && state.id === id && state.tabId === sender.tab?.id &&
    LinkedInJobCollector.searchKey(sender.url) === state.searchKey;
}
function publicCollection(state) {
  if (!state) return null;
  const { id, searchKey, visited, pages, counts } = state;
  return { id, searchKey, visited, pages, counts };
}
async function waitForCollectionRun(message, sender) {
  const delay = message.milliseconds;
  if (!Number.isSafeInteger(delay) || delay < 1 || delay > 20_000) throw new Error("The collection delay is invalid.");
  let waiting;
  await withCollectionState(async (state) => {
    if (!collectionMatches(state, sender, message.runId)) return;
    const previous = collectionWaits.get(state.id);
    if (previous) {
      if (!sender.documentId || !previous.documentId || sender.documentId === previous.documentId) {
        throw new Error("A collection delay is already pending.");
      }
      // A full Next navigation can replace the document while its last wait
      // is pending. The newly authorized document takes over that same run.
      clearTimeout(previous.timer); collectionWaits.delete(state.id); previous.resolve({ stopped: true });
    }
    // Schedule in the worker, outside the serialized state queue. Stop and
    // settings changes must be able to cancel a wait immediately.
    waiting = new Promise((resolve) => {
      const timer = setTimeout(() => {
        collectionWaits.delete(state.id);
        withCollectionState((latest) => ({ stopped: !collectionMatches(latest, sender, message.runId) }))
          .then(resolve, () => resolve({ stopped: true }));
      }, delay);
      collectionWaits.set(state.id, { timer, resolve, documentId: sender.documentId });
    });
  });
  return waiting || { stopped: true };
}
async function handleCollectionMessage(message, sender) {
  return withCollectionState(async (state, save) => {
    if (message.type === "KAI_TRACKER_RUN_STATE") {
      if (state?.tabId === sender.tab?.id && !collectionMatches(state, sender)) { await save(null); await setBadge("", "#56687a"); }
      return { state: collectionMatches(state, sender) ? publicCollection(state) : null };
    }
    if (message.type === "KAI_TRACKER_RUN_END" && state?.id === message.runId && state.tabId === sender.tab?.id) {
      await save(null); await setBadge("", "#56687a"); return { stopped: true };
    }
    if (!collectionMatches(state, sender, message.runId)) return { stopped: true };
    const visited = message.state?.visited;
    const pages = message.state?.pages;
    if (!Array.isArray(visited) || visited.length > 10_000 || !visited.every((id) => /^\d+$/u.test(id)) ||
      !Array.isArray(pages) || pages.length > 1000 || !pages.every((value) => typeof value === "string" && value.length < 50_000)) throw new Error("The results history could not be recorded.");
    state.visited = [...new Set([...state.visited, ...visited])];
    state.pages = [...new Set([...state.pages, ...pages])];
    for (const field of ["saved", "researching", "skipped"]) {
      const count = message.state.counts?.[field];
      if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) throw new Error("The collection count could not be recorded.");
      state.counts[field] = Math.max(state.counts[field], count);
    }
    await save(state);
    return { state: publicCollection(state) };
  });
}
async function stopActiveCollection() {
  const previous = await withCollectionState(async (state, save) => { await save(null); return state; });
  if (previous) await setBadge("", "#56687a");
  if (previous) try { await chrome.tabs.sendMessage(previous.tabId, { type: "KAI_TRACKER_RUN_STOP" }); } catch { /* Navigated or closed tab. */ }
}

async function captureJob(job, { profile = "", tabId = null } = {}) {
  const roleSkipReason = JobCapturePolicy.roleSkipReason(job);
  if (roleSkipReason) return { status: "skipped", reason: roleSkipReason };
  if (await bannedCompanies.has(job?.company)) {
    const failure = new Error("This company is in the tracker’s banned-company list. Nothing was added.");
    failure.code = "BANNED_COMPANY";
    throw failure;
  }
  if (job?.applicationsClosed === true) return { status: "skipped", reason: "Applications are closed. Nothing was added." };
  if (job?.applicationsAvailable === false) return { status: "skipped", reason: "An active Apply control could not be verified. Nothing was added." };
  const lookup = await sheetClient.lookupDuplicate(job.company);
  if (lookup?.duplicate) throw Object.assign(new Error("This company already has a recorded job. Nothing was added."), { code: "DUPLICATE_COMPANY", details: lookup });
  return researchClient.start(job, { profile, tabId });
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
    const failure = new Error("The Kai Flow company list is not available yet.");
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
        const failure = new Error("The Kai Flow returned an unmatched company revision.");
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
  if (command === "toggle-job-collection") void toggleJobCollection(commandTab);
});
chrome.tabs.onRemoved?.addListener((tabId) => {
  void withCollectionState(async (state, save) => { if (state?.tabId === tabId) { await save(null); await setBadge("", "#56687a"); } }).catch(() => {});
});

async function toggleJobCollection(commandTab) {
  let tab = commandTab;
  let startedId = "";
  try {
    const running = await withCollectionState((state) => !!state);
    if (running) { await stopActiveCollection(); return; }
    tab = tab?.id ? tab : await getActiveTab();
    const searchKey = LinkedInJobCollector.searchKey(tab?.url);
    if (!tab?.id || !searchKey) throw new Error("Open LinkedIn job search results before starting job collection.");
    const toggle = await withCollectionState(async (state, save) => {
      if (state) { await save(null); return { stop: state }; }
      const status = await sheetClient.getStatus();
      if (!status.configured) throw new Error("Start Kai Flow before starting job collection.");
      await classifyCompanies([], { refresh: false });
      const currentTab = await chrome.tabs.get(tab.id);
      const next = { id: crypto.randomUUID(), tabId: tab.id, searchKey, originalAutoDiscardable: currentTab.autoDiscardable,
        visited: [], pages: [], counts: { saved: 0, researching: 0, skipped: 0 } };
      startedId = next.id;
      await save(next);
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
      return { state: next, stop: state };
    });
    if (toggle.stop) try { await chrome.tabs.sendMessage(toggle.stop.tabId, { type: "KAI_TRACKER_RUN_STOP" }); } catch { /* The previous tab may have closed. */ }
    if (!toggle.state) { await withCollectionState(async (state) => { if (!state) await setBadge("", "#56687a"); }); return; }
    startedId = toggle.state.id;
    const message = { type: "KAI_TRACKER_RUN_START", state: publicCollection(toggle.state) };
    let response;
    try { response = await chrome.tabs.sendMessage(tab.id, message); }
    catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/scraper.js", "src/detail-copy.js", "src/job-collector.js", "src/content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, message);
    }
    if (!response?.ok) throw new Error(response?.error || "The collection controls could not be started. Reload the LinkedIn tab.");
    await withCollectionState(async (state) => { if (state?.id === startedId) await setBadge("RUN", "#1f7a3f"); });
  } catch (error) {
    if (startedId) await withCollectionState(async (state, save) => { if (state?.id === startedId) await save(null); });
    await notify(tab?.id, error.message, "error");
  }
}

async function runScrapeAndSaveShortcut(commandTab) {
  let tab = commandTab || null;
  let job = null;
  try {
    await setBadge("...", "#56687a");
    tab = tab?.id ? tab : await getActiveTab();
    if (!tab?.id) throw new Error("No active tab found.");
    if (!isSupportedUrl(tab.url || "")) throw new Error("Open a LinkedIn job page before using the shortcut.");

    const scrapeResponse = await requestScrape(tab.id);
    if (!scrapeResponse?.ok) throw new Error(scrapeResponse?.error || "The scraper did not return data.");
    job = scrapeResponse.data;
    if (await bannedCompanies.has(scrapeResponse.data.company)) {
      const failure = new Error("This company is in the tracker’s banned-company list. Nothing was added.");
      failure.code = "BANNED_COMPANY";
      throw failure;
    }

    const savedSettings = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    const profile = savedSettings[PROFILE_STORAGE_KEY] ?? "";
    const result = await captureJob(scrapeResponse.data, { profile, tabId: tab.id });
    await setBadge(result.status === "researching" ? "AI" : result.status === "skipped" ? "SKIP" : "OK", "#1f7a3f");
    await notify(tab.id, result.status === "researching" ? "Research started."
      : result.status === "skipped" ? job.applicationsClosed ? "Skipped: applications closed." : "Skipped: apply button unavailable."
      : "Saved to Kai Flow.", "info", job);
  } catch (error) {
    if (error.code === "DUPLICATE_COMPANY") {
      await setBadge("DUP", "#8a6d1d");
      await notify(tab?.id, "Skipped: company already in sheet.", "warning", job);
    } else if (error.code === "BANNED_COMPANY") {
      await setBadge("BAN", "#b3261e");
      await notify(tab?.id, "Skipped: company is banned.", "warning", job);
    } else {
      await setBadge("ERR", "#b3261e");
      await notify(tab?.id, error.message, "error", job);
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
        files: ["src/scraper.js", "src/detail-copy.js", "src/job-collector.js", "src/content.js"]
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

async function notify(tabId, message, tone = "info", job = null) {
  const label = [JobCapturePolicy.text(job?.company), JobCapturePolicy.text(job?.title ?? job?.jobTitle)].filter(Boolean).join(" — ");
  if (label) message = `${label}\n${message}`;
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
    whiteSpace: "pre-line",
    overflowWrap: "anywhere",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.22)"
  });
  document.documentElement.append(toast);
  setTimeout(() => toast.remove(), 5000);
}
