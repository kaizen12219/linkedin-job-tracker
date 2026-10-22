importScripts("folder-access.js", "kai-local-store-client.js", "failure-reports.js", "banned-companies.js", "capture-policy.js", "profile-routing.js", "research-client.js", "job-collector.js");

const sheetClient = KaiLocalStoreClient.create();
const failureReports = JobFailureReports.create({ sheetClient });
const bannedCompanies = KaiFlowBannedCompanies.create();
const researchClient = JobResearchClient.create({ sheetClient, bannedCompanies,
  onNotSaved: async (record, details) => logNotSaved(record.job, { ...details, requestId: record.requestId,
    sheetUrl: record.sheetUrl, model: record.model, reasoningEffort: record.reasoningEffort, profile: record.profile }),
  onProfileSelected: async (record, selection) => {
    try { await chrome.runtime.sendMessage({ type: "KAI_TRACKER_PROFILE_SELECTED", jobId: record.job.jobId, sourceUrl: record.job.sourceUrl,
      company: record.job.company, title: record.job.title, description: record.job.description, ...selection }); }
    catch { /* The popup may be closed; the persisted selection is unchanged. */ }
  },
  onSaved: async (company) => {
    try { await rememberTrackedCompany(company); } catch { /* Confirmed Sheet writes remain successful. */ }
    await refreshLinkedInStyles();
    void refreshSnapshotAndStyles({ force: true });
  },
  onOutcome: async (record, message, result) => {
    if (result) try { await failureReports.resolve(record.requestId); } catch { /* A confirmed save remains successful. */ }
    return notify(record.tabId, message,
      result ? "success" : record.state === "failed" || record.state === "save-unconfirmed" ? "error" : "info", record.job);
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === JobResearchClient.ALARM) void researchClient.poll().catch(() => {});
  if (alarm.name === JobFailureReports.ALARM) void failureReports.flush().catch(() => {});
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
const COLLECTION_STORAGE_KEY = "jobTrackerCollectionsV2";
const LEGACY_COLLECTION_STORAGE_KEY = "jobTrackerCollectionV1";
const MAX_COLLECTIONS = 2;
const DESCRIPTION_TIMEOUT_MS = 20_000;
const DESCRIPTION_MAX_BYTES = 750_000;
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
  "KAI_TRACKER_RESEARCH_MODELS",
  "KAI_TRACKER_RESEARCH_MODEL_SET",
  "KAI_TRACKER_RESEARCH_EFFORT_SET",
  "KAI_TRACKER_RESEARCH_START",
  "KAI_TRACKER_BANNED_GET",
  "KAI_TRACKER_BANNED_SET"
]);

async function initialize() {
  try {
    await Promise.all([sheetClient.init(), bannedCompanies.list(), loadCompanySnapshot()]);
    void failureReports.flush().catch(() => {});
    await withCollections(async (states, save) => {
      const current = [];
      for (const state of states) {
        try {
          const tab = await chrome.tabs.get(state.tabId);
          if (LinkedInJobCollector.searchKey(tab.url) !== state.searchKey) continue;
          await chrome.tabs.update(state.tabId, { autoDiscardable: false });
          current.push(state);
        } catch { /* Only the missing or changed tab loses its run. */ }
      }
      await save(current);
    });
    await refreshCollectionBadge();
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
  const reportMessage = message?.type === "KAI_TRACKER_NOT_SAVED";
  const descriptionMessage = message?.type === "KAI_TRACKER_DESCRIPTION";
  if (!popupMessage && !classifyMessage && !captureMessage && !collectionMessage && !reportMessage && !descriptionMessage) return undefined;

  if (popupMessage && !isPopupSender(sender)) {
    sendResponse({ ok: false, error: { code: "TRACKER_FORBIDDEN", message: "Open the tracker popup to change or save data." } });
    return false;
  }
  if ((classifyMessage || captureMessage || collectionMessage || reportMessage) && !isJobPageSender(sender)) {
    sendResponse({ ok: false, error: { code: "TRACKER_FORBIDDEN", message: "Open a supported LinkedIn or Jobright job page." } });
    return false;
  }
  if (descriptionMessage && (!isJobPageSender(sender) || JobCapturePolicy.sourceSite(sender.url) !== "linkedin")) {
    sendResponse({ ok: false, error: { code: "TRACKER_FORBIDDEN", message: "Open the selected LinkedIn job page to load its public description." } });
    return false;
  }

  handleTrackerMessage(message, sender).then(
    (result) => {
      sendResponse({ ok: true, result });
      if (captureMessage && !message.runId) void notify(sender.tab?.id, result.status === "researching"
        ? result.queued ? "Job queued for research. It will retry automatically when the local research worker is running."
        : "Job research started. This job will be added only if it qualifies."
        : result.status === "skipped" ? result.reason : `Saved ${message.job.company} to ApplicantAlly.`, result.status === "inserted" ? "success" : "info").catch(() => {});
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
  return sender?.id === chrome.runtime.id && ["popup.html", "folder.html"].some(file => sender?.url === chrome.runtime.getURL(file));
}

function isJobPageSender(sender) {
  return sender?.id === chrome.runtime.id && isSupportedUrl(sender.url);
}
function matchesJobSource(job, sender) {
  return JobCapturePolicy.validJobId(String(job?.jobId || ""), job?.sourceUrl) &&
    JobCapturePolicy.sourceSite(job.sourceUrl) === JobCapturePolicy.sourceSite(sender.url);
}
async function verifyCaptureIdentity(job, sender) {
  const mismatch = (reason = "") => Object.assign(new Error("The selected job source and identity could not be verified." + (reason ? " " + reason : "")), { code: "TRACKER_IDENTITY_MISMATCH" });
  const jobId = String(job?.jobId || "");
  if (!matchesJobSource(job, sender)) throw mismatch();
  const site = JobCapturePolicy.sourceSite(job.sourceUrl);
  if (site === "linkedin" && JobCapturePolicy.validJobId(jobId, sender.url)) return;
  const provider = site === "jobright" ? "Jobright" : "LinkedIn";
  // A job page can move to another selection while MessageSender.url still
  // names the content script's original page. Bind the capture to the live
  // top-frame document instead of accepting an arbitrary same-site job ID.
  if (!Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || typeof sender.documentId !== "string" || !sender.documentId ||
    (sender.documentLifecycle && sender.documentLifecycle !== "active")) throw mismatch(`Restart collection from the current ${provider} page.`);
  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [0] },
      func: () => window.location.href
    });
  } catch { throw mismatch(`The current ${provider} page could not be rechecked. Refresh it and restart collection.`); }
  const frame = Array.isArray(frames) && frames.length === 1 ? frames[0] : null;
  if (frame?.frameId !== 0 || frame.documentId !== sender.documentId) throw mismatch(`The ${provider} page was replaced before capture. Restart collection on the current page.`);
  if (JobCapturePolicy.sourceSite(frame.result) !== site ||
    JobCapturePolicy.jobIdFromUrl(frame.result) !== jobId || !JobCapturePolicy.validJobId(jobId, frame.result)) throw mismatch(`${provider} is no longer showing the captured job. Nothing was saved.`);
}

function descriptionUnavailable(reason) {
  return Object.assign(new Error(`LinkedIn's public job description could not be loaded. ${reason}`), { code: "TRACKER_DESCRIPTION_UNAVAILABLE" });
}
async function verifyDescriptionContext(job, sender, runId) {
  const mismatch = () => Object.assign(new Error("The LinkedIn description request no longer matches the selected job and active page."), { code: "TRACKER_IDENTITY_MISMATCH" });
  const jobId = String(job?.jobId || "");
  if (!/^\d{1,32}$/u.test(jobId) || JobCapturePolicy.sourceSite(job?.sourceUrl) !== "linkedin" ||
    !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || typeof sender.documentId !== "string" || !sender.documentId ||
    (sender.documentLifecycle && sender.documentLifecycle !== "active")) throw mismatch();
  await verifyCaptureIdentity(job, sender);
  // Even the capture fast path must recheck this read-only fetch: a stale
  // document must never supply HTML to a replacement page or another job.
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [0] }, func: () => window.location.href });
  } catch { throw mismatch(); }
  const frame = Array.isArray(frames) && frames.length === 1 ? frames[0] : null;
  if (frame?.frameId !== 0 || frame.documentId !== sender.documentId ||
    JobCapturePolicy.sourceSite(frame.result) !== "linkedin" || JobCapturePolicy.jobIdFromUrl(frame.result) !== jobId ||
    !JobCapturePolicy.validJobId(jobId, frame.result)) throw mismatch();
  if (runId) await withCollectionState(state => {
    if (!collectionMatches(state, sender, runId) || !collectionMatches(state, { ...sender, url: frame.result }, runId))
      throw Object.assign(new Error("Job collection stopped or its search changed before the description was ready."), { code: "TRACKER_RUN_STOPPED" });
  }, sender.tab.id);
  return jobId;
}
function publicDescriptionUrl(value, jobId) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["www.linkedin.com", "linkedin.com"].includes(url.hostname) ||
      url.username || url.password || (url.port && url.port !== "443")) return "";
    if (url.searchParams.getAll("currentJobId").some(value => value !== jobId)) return "";
    const segment = /^\/jobs\/view\/([^/]+)\/?$/u.exec(url.pathname)?.[1];
    if (!segment || /%(?:2f|5c|00)/iu.test(segment)) return "";
    const decoded = decodeURIComponent(segment);
    const id = /^\d+$/u.test(decoded) ? decoded : /^[^/\\?#\s]+-(\d+)$/u.exec(decoded)?.[1];
    if (id !== jobId) return "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}
async function readDescriptionHtml(response, controller) {
  const length = response.headers?.get?.("content-length");
  if (length && /^\d+$/u.test(length) && Number(length) > DESCRIPTION_MAX_BYTES)
    throw descriptionUnavailable("The public page exceeds the 750,000-byte limit.");
  const reader = response.body?.getReader?.();
  if (!reader) {
    const html = await response.text();
    if (typeof html !== "string" || html.length > DESCRIPTION_MAX_BYTES || new TextEncoder().encode(html).byteLength > DESCRIPTION_MAX_BYTES)
      throw descriptionUnavailable("The public page exceeds the 750,000-byte limit.");
    return html;
  }
  const decoder = new TextDecoder();
  const parts = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > DESCRIPTION_MAX_BYTES) {
        controller.abort();
        void Promise.resolve(reader.cancel()).catch(() => {});
        throw descriptionUnavailable("The public page exceeds the 750,000-byte limit.");
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally { reader.releaseLock?.(); }
}
async function loadLinkedInDescription(message, sender) {
  const jobId = await verifyDescriptionContext(message.job, sender, message.runId);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(descriptionUnavailable("The public page did not respond within 20 seconds."));
    }, DESCRIPTION_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([timeout, (async () => {
      let response;
      try {
        response = await fetch(`https://www.linkedin.com/jobs/view/${jobId}/`, {
          method: "GET", credentials: "omit", redirect: "follow", cache: "no-store", signal: controller.signal,
          headers: { Accept: "text/html" }
        });
      } catch { throw descriptionUnavailable("The public page request failed."); }
      if (response.status !== 200) throw descriptionUnavailable(`The public page returned HTTP ${Number(response.status) || "unknown"}.`);
      const sourceUrl = publicDescriptionUrl(response.url, jobId);
      if (!sourceUrl) throw descriptionUnavailable("The public page redirected to a sign-in page, another job, or an unsupported URL.");
      if (!/^text\/html(?:\s*;|\s*$)/iu.test(response.headers?.get?.("content-type") || ""))
        throw descriptionUnavailable("The public page did not return HTML.");
      const html = await readDescriptionHtml(response, controller);
      // Public job pages also have sign-in prompts. Only reject a document
      // identifying itself as the login/authwall, not those ordinary prompts.
      if (/<title\b[^>]*>\s*(?:sign\s*in|log\s*in|linkedin\s+(?:login|sign\s*in)|join\s+linkedin)(?:\s|[<|—–-])/iu.test(html) ||
        /<(?:body|main)\b[^>]*(?:class|id)\s*=\s*["'][^"']*\bauthwall\b/iu.test(html))
        throw descriptionUnavailable("LinkedIn returned a sign-in or authwall page instead of the public job.");
      return { jobId, sourceUrl, html };
    })()]);
    await verifyDescriptionContext(message.job, sender, message.runId);
    return result;
  } catch (error) {
    controller.abort();
    if (error?.code) throw error;
    throw descriptionUnavailable("The public HTML response could not be read.");
  } finally { clearTimeout(timer); }
}

async function handleTrackerMessage(message, sender = {}) {
  if (message.type === "KAI_TRACKER_DESCRIPTION") return loadLinkedInDescription(message, sender);
  if (message.type === "KAI_TRACKER_NOT_SAVED") {
    const reasons = { BANNED_COMPANY: "Skipped: company is in the banned-company list.",
      DUPLICATE_COMPANY: "Skipped: company already has a recorded job.",
      ALREADY_CAPTURED: "Skipped: this job was already submitted from this page.",
      DETAILS_NOT_CONFIRMED: "The selected job's full details and identity could not be confirmed.",
      CARD_UNAVAILABLE: "The attempted job card became unavailable before capture." };
    if (!reasons[message.reasonCode] || !matchesJobSource(message.job, sender) ||
      (message.reasonCode === "ALREADY_CAPTURED" && JobCapturePolicy.sourceSite(message.job.sourceUrl) !== "jobright")) throw new Error("The failed job snapshot is invalid.");
    if (message.runId) await withCollectionState(state => {
      if (!collectionMatches(state, sender, message.runId)) throw Object.assign(new Error("Job collection stopped."), { code: "TRACKER_RUN_STOPPED" });
    }, sender.tab?.id);
    return logNotSaved(message.job, { stage: "capture", status: ["BANNED_COMPANY", "DUPLICATE_COMPANY", "ALREADY_CAPTURED"].includes(message.reasonCode) ? "skipped" : "failed",
      reason: reasons[message.reasonCode], error: { code: message.reasonCode, message: reasons[message.reasonCode] } });
  }
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
  if (message.type === "KAI_TRACKER_RESEARCH_MODELS") return researchClient.getModels();
  if (message.type === "KAI_TRACKER_RESEARCH_MODEL_SET") return researchClient.setModel(message.model);
  if (message.type === "KAI_TRACKER_RESEARCH_EFFORT_SET") return researchClient.setReasoningEffort(message.reasoningEffort);
  if (message.type === "KAI_TRACKER_RESEARCH_START") return researchClient.startWorker();
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
    try { await verifyCaptureIdentity(message.job, sender); }
    catch (error) {
      if (matchesJobSource(message.job, sender) && (sender.frameId === undefined || sender.frameId === 0))
        await logNotSaved(message.job, { stage: "capture", status: "failed", reason: error.message, error });
      throw error;
    }
    const settings = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    profile = settings[PROFILE_STORAGE_KEY] ?? "";
  }
  if (message.runId) {
    const claimed = await withCollectionState(async (state, save) => {
      if (!collectionMatches(state, sender, message.runId)) throw Object.assign(new Error("Job collection stopped. Nothing was added."), { code: "TRACKER_RUN_STOPPED" });
      const jobId = String(message.job?.jobId || "");
      if (!JobCapturePolicy.validJobId(jobId, message.job.sourceUrl) || message.job.jobIdSource === "query" ||
        (state.filterKey && message.job.searchContextKey !== state.filterKey) ||
        (JobCapturePolicy.sourceSite(message.job.sourceUrl) !== "jobright" &&
          LinkedInJobCollector.searchKey(message.job.sourceUrl) !== state.searchKey)) throw new Error("The selected job could not be verified for this search.");
      if (state.visited.includes(jobId)) return false;
      // Persist before the Sheet/research request, so a reload or lost response
      // cannot replay an uncertain save from this run.
      state.visited.push(jobId);
      await save(state);
      return true;
    }, sender.tab?.id);
    if (!claimed) return { status: "skipped", reason: "This job was already processed in this run." };
  }
  const result = await captureJob(message.job, { profile, tabId: sender.tab?.id });
  if (message.runId) await withCollectionState(async (state, save) => {
    if (!collectionMatches(state, sender, message.runId)) return;
    const field = result.status === "inserted" ? "saved" : result.status === "researching" ? "researching" : "skipped";
    state.counts[field]++;
    await save(state);
  }, sender.tab?.id);
  return result;
}

function withCollections(action) {
  const operation = collectionQueue.catch(() => {}).then(async () => {
    const storage = chrome.storage.session;
    if (!storage) throw new Error("Session storage is unavailable. Reload the extension.");
    const saved = await storage.get([COLLECTION_STORAGE_KEY, LEGACY_COLLECTION_STORAGE_KEY]);
    let states = saved[COLLECTION_STORAGE_KEY];
    if (states === undefined) {
      states = saved[LEGACY_COLLECTION_STORAGE_KEY] ? [saved[LEGACY_COLLECTION_STORAGE_KEY]] : [];
      await storage.set({ [COLLECTION_STORAGE_KEY]: states, [LEGACY_COLLECTION_STORAGE_KEY]: null });
    }
    if (!Array.isArray(states) || states.length > MAX_COLLECTIONS) throw new Error("Collection state is invalid. Reload the extension.");
    return action(states, async (value) => {
      await storage.set({ [COLLECTION_STORAGE_KEY]: value });
      for (const state of states.filter(previous => !value.some(next => next.id === previous.id && next.tabId === previous.tabId))) {
        const wait = collectionWaits.get(state.id);
        if (wait) { clearTimeout(wait.timer); collectionWaits.delete(state.id); wait.resolve({ stopped: true }); }
        if (typeof state.originalAutoDiscardable === "boolean") {
          try { await chrome.tabs.update(state.tabId, { autoDiscardable: state.originalAutoDiscardable }); }
          catch { /* Closed tabs need no restoration. */ }
        }
      }
      states = value;
    });
  });
  collectionQueue = operation.catch(() => {});
  return operation;
}
function withCollectionState(action, tabId) {
  return withCollections((states, save) => action(states.find(state => state.tabId === tabId) || null,
    value => save(value ? [...states.filter(state => state.tabId !== tabId), value] : states.filter(state => state.tabId !== tabId))));
}
async function refreshCollectionBadge() {
  const count = await withCollections(states => states.length);
  await setBadge(count ? count === 1 ? "RUN" : "RUN2" : "", count ? "#1f7a3f" : "#56687a");
}
function collectionMatches(state, sender, id = state?.id) {
  return !!state && state.id === id && state.tabId === sender.tab?.id &&
    LinkedInJobCollector.searchKey(sender.url) === state.searchKey;
}
function publicCollection(state) {
  if (!state) return null;
  const { id, searchKey, visited, pages, counts, filterKey } = state;
  return { id, searchKey, visited, pages, counts, ...(filterKey ? { filterKey } : {}) };
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
        withCollectionState((latest) => ({ stopped: !collectionMatches(latest, sender, message.runId) }), sender.tab?.id)
          .then(resolve, () => resolve({ stopped: true }));
      }, delay);
      collectionWaits.set(state.id, { timer, resolve, documentId: sender.documentId });
    });
  }, sender.tab?.id);
  return waiting || { stopped: true };
}
async function handleCollectionMessage(message, sender) {
  return withCollectionState(async (state, save) => {
    if (message.type === "KAI_TRACKER_RUN_STATE") {
      if (state && !collectionMatches(state, sender)) { await save(null); return { state: null }; }
      return { state: collectionMatches(state, sender) ? publicCollection(state) : null };
    }
    if (message.type === "KAI_TRACKER_RUN_END" && state?.id === message.runId && state.tabId === sender.tab?.id) {
      await save(null); return { stopped: true };
    }
    if (!collectionMatches(state, sender, message.runId)) return { stopped: true };
    const visited = message.state?.visited;
    const pages = message.state?.pages;
    if (!Array.isArray(visited) || visited.length > 10_000 || !visited.every((id) => JobCapturePolicy.validJobId(id, state.searchKey)) ||
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
  }, sender.tab?.id).then(async result => { await refreshCollectionBadge(); return result; });
}
async function stopActiveCollection(tabId) {
  const previous = await withCollections(async (states, save) => {
    const stopped = states.filter(state => tabId === undefined || state.tabId === tabId);
    await save(states.filter(state => !stopped.includes(state)));
    return stopped;
  });
  await refreshCollectionBadge();
  await Promise.allSettled(previous.map(state => chrome.tabs.sendMessage(state.tabId, { type: "KAI_TRACKER_RUN_STOP" })));
}

async function captureJob(job, { profile = "", tabId = null } = {}) {
  try {
    const reason = JobCapturePolicy.roleSkipReason(job) || (job?.applicationsClosed === true ? "Applications are closed. Nothing was added."
      : job?.applicationsAvailable === false ? "An active Apply control could not be verified. Nothing was added." : "");
    if (reason) {
      await logNotSaved(job, { stage: "local-policy", status: "skipped", reason, profile });
      return { status: "skipped", reason };
    }
    if (await bannedCompanies.has(job?.company)) throw Object.assign(new Error("This company is in the tracker’s banned-company list. Nothing was added."), { code: "BANNED_COMPANY" });
    const lookup = await sheetClient.lookupDuplicate(job.company);
    if (lookup?.duplicate) throw Object.assign(new Error("This company already has a recorded job. Nothing was added."), { code: "DUPLICATE_COMPANY", details: lookup });
    return await researchClient.start(job, { profile, tabId });
  } catch (error) {
    if (!error.notSavedReported) await logNotSaved(job, { stage: "capture", status: ["BANNED_COMPANY", "DUPLICATE_COMPANY"].includes(error.code) ? "skipped" : "failed",
      reason: error.message, error, profile });
    throw error;
  }
}

async function logNotSaved(job, details) {
  try {
    const settings = await chrome.storage.local.get(["jobTrackerResearchModelV1", "jobTrackerResearchEffortV1"]);
    return await failureReports.record(job, { model: settings.jobTrackerResearchModelV1 || "",
      reasoningEffort: settings.jobTrackerResearchEffortV1 || "", ...details });
  } catch { return { queued: true }; /* Reporting cannot prevent collection or a confirmed save. */ }
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
    const failure = new Error("The ApplicantAlly company list is not available yet.");
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
        const failure = new Error("The ApplicantAlly returned an unmatched company revision.");
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
    tabs = await chrome.tabs.query({ url: ["https://linkedin.com/jobs/*", "https://*.linkedin.com/jobs/*", "https://jobright.ai/jobs/*", "https://www.jobright.ai/jobs/*"] });
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
  void stopActiveCollection(tabId).catch(() => {});
});

async function toggleJobCollection(commandTab) {
  let tab = commandTab;
  let startedId = "";
  try {
    tab = tab?.id ? tab : await getActiveTab();
    const ownRun = await withCollectionState(state => !!state, tab?.id);
    if (ownRun) { await stopActiveCollection(tab.id); return; }
    const searchKey = LinkedInJobCollector.searchKey(tab?.url);
    if (!tab?.id || !searchKey) {
      if (await withCollections(states => states.length)) { await stopActiveCollection(); return; }
      throw new Error("Open LinkedIn or Jobright job search results before starting job collection.");
    }
    let filterKey = "";
    if (JobCapturePolicy.sourceSite(tab.url) === "jobright") {
      const response = await requestContent(tab.id, tab.url, { type: "KAI_TRACKER_SEARCH_CONTEXT" });
      filterKey = response?.ok && response.result?.filterKey;
      if (typeof filterKey !== "string" || !filterKey.startsWith("jobright:") || filterKey.length > 20_000 ||
        response.result.selectedRegion !== "us" || response.result.selectedRegionSource !== "search-control")
        throw new Error("Select United States in Jobright's search country filter, then refresh the page before collecting.");
    }
    const toggle = await withCollections(async (states, save) => {
      const state = states.find(current => current.tabId === tab.id);
      if (state) { await save(states.filter(current => current !== state)); return { stop: state }; }
      if (states.length >= MAX_COLLECTIONS) throw new Error("Two collectors are already running. Stop one before starting another.");
      const status = await sheetClient.getStatus();
      if (!status.configured) throw new Error("Choose your ApplicantAlly data folder before starting job collection.");
      await classifyCompanies([], { refresh: false });
      const currentTab = await chrome.tabs.get(tab.id);
      const next = { id: crypto.randomUUID(), tabId: tab.id, searchKey, originalAutoDiscardable: currentTab.autoDiscardable,
        visited: [], pages: [], counts: { saved: 0, researching: 0, skipped: 0 }, ...(filterKey ? { filterKey } : {}) };
      startedId = next.id;
      await save([...states, next]);
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
      return { state: next, stop: state };
    });
    if (toggle.stop) try { await chrome.tabs.sendMessage(toggle.stop.tabId, { type: "KAI_TRACKER_RUN_STOP" }); } catch { /* The previous tab may have closed. */ }
    if (!toggle.state) { await refreshCollectionBadge(); return; }
    startedId = toggle.state.id;
    const message = { type: "KAI_TRACKER_RUN_START", state: publicCollection(toggle.state) };
    const response = await requestContent(tab.id, tab.url, message);
    if (!response?.ok) throw new Error(response?.error || "The collection controls could not be started. Reload the job search tab.");
    await refreshCollectionBadge();
  } catch (error) {
    if (startedId) await withCollectionState(async (state, save) => { if (state?.id === startedId) await save(null); }, tab?.id);
    await refreshCollectionBadge();
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
    if (!isSupportedUrl(tab.url || "")) throw new Error("Open a LinkedIn or Jobright job page before using the shortcut.");

    const scrapeResponse = await requestContent(tab.id, tab.url, { type: "SCRAPE_LINKEDIN_JOB" });
    if (!scrapeResponse?.ok) throw new Error(scrapeResponse?.error || "The scraper did not return data.");
    job = scrapeResponse.data;
    const savedSettings = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    const profile = savedSettings[PROFILE_STORAGE_KEY] ?? "";
    const result = await captureJob(scrapeResponse.data, { profile, tabId: tab.id });
    await setBadge(result.status === "researching" ? "AI" : result.status === "skipped" ? "SKIP" : "OK", "#1f7a3f");
    await notify(tab.id, result.status === "researching" ? result.queued ? "Job queued for research. It will retry automatically when the local research worker is running." : "Research started."
      : result.status === "skipped" ? job.applicationsClosed ? "Skipped: applications closed." : "Skipped: apply button unavailable."
      : "Saved to ApplicantAlly.", "info", job);
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
    setTimeout(() => void refreshCollectionBadge().catch(() => {}), BADGE_TIMEOUT_MS);
  }
}

async function getActiveTab() {
  const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focusedTabs[0]) return focusedTabs[0];
  const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return currentTabs[0] || null;
}

function contentScripts(url) {
  return JobCapturePolicy.sourceSite(url) === "jobright"
    ? ["src/capture-policy.js", "src/profile-routing.js", "src/jobright-scraper.js", "src/job-collector.js", "src/jobright-content.js"]
    : ["src/capture-policy.js", "src/profile-routing.js", "src/scraper.js", "src/detail-copy.js", "src/job-collector.js", "src/content.js"];
}
async function requestContent(tabId, url, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: contentScripts(url)
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function isSupportedUrl(url) {
  return JobCapturePolicy.supportedJobPage(url);
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
