const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const BACKGROUND = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const BANNED = fs.readFileSync(path.join(ROOT, "src/banned-companies.js"), "utf8");
const SNAPSHOT_KEY = "kaiFlowCompanySnapshotV1";
const COLLECTIONS_KEY = "jobTrackerCollectionsV2";
const duties = "Design and build JavaScript services and maintain automated tests.";
const engineeringJob = { jobId: "123", jobIdSource: "details", sourceUrl: "https://www.linkedin.com/jobs/search-results/",
  company: "New Company", title: "Senior JavaScript Engineer", description: duties, workplaceType: "remote", isEasyApply: false };
const successfulResearch = async (_url, options) => ({ ok: true, json: async () => options.method === "POST" ? { state: "queued" }
  : { state: "completed", completedAt: new Date().toISOString(), result: { decision: "save", company: engineeringJob.company,
    title: engineeringJob.title, role: { eligible: true, category: "software-development", evidence: duties } } } });

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function harness({ stored = {}, sessionStored = {}, snapshots = [{ companies: ["Acme"], revision: "r1" }], banned = ["Blocked Co"], researchFetch = null, descriptionFetch = null, saveError = null, autoDiscardable = true, profiles = [],
  tabUrl = "https://www.linkedin.com/jobs/search-results/", searchContext = null, tabStates = {}, searchContexts = {}, injectionResults = {}, injectionError = null } = {}) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const messageListeners = [];
  const tabRemovedListeners = [];
  let snapshotCursor = 0;
  const local = {
    async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, clone(stored[name])])); },
    async set(value) { Object.assign(stored, clone(value)); },
    async remove(key) { for (const name of Array.isArray(key) ? key : [key]) delete stored[name]; }
  };
  const client = {
    async init() {},
    async getStatus() { calls.push({ action: "status" }); return { configured: true, sheetUrl: "applicantally-file:00000000-0000-0000-0000-000000000001" }; },
    async configure() { calls.push({ action: "configure" }); return { configured: true }; },
    async clearConfiguration() { calls.push({ action: "clear" }); return { configured: false }; },
    async getOptions() { return { profiles }; },
    async lookupDuplicate() { calls.push({ action: "duplicate" }); return { duplicate: null }; },
    async getCompanies(options) {
      calls.push({ action: "companies", options: clone(options) });
      const response = snapshots[Math.min(snapshotCursor++, snapshots.length - 1)];
      return typeof response === "function" ? response(options) : clone(response);
    },
    async saveJob(job, options) {
      calls.push({ action: "save", company: job.company, options: clone(options) });
      if (saveError) throw saveError;
      return { status: "inserted", job: { company: job.company, rowNumber: 10 } };
    },
    async saveFailureReport(report, options) { calls.push({ action: "failure-report", report: clone(report), options: clone(options) }); return { written: true }; }
  };
  const chrome = {
    alarms: { onAlarm: { addListener() {} }, async create() {}, async clear() {} },
    storage: { local, session: {
      async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, clone(sessionStored[name])])); },
      async set(values) { Object.assign(sessionStored, clone(values)); },
      async remove(key) { for (const name of Array.isArray(key) ? key : [key]) delete sessionStored[name]; }
    } },
    runtime: {
      id: "extension-id",
      getURL(value) { return `chrome-extension://extension-id/${value}`; },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { messageListeners.push(listener); } }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {}
    },
    tabs: {
      async get(id) {
        if (Object.hasOwn(tabStates, id) && !tabStates[id]) throw new Error("Tab no longer exists");
        return { id, url: tabUrl, autoDiscardable, ...clone(tabStates[id]) };
      },
      async update(id, properties) {
        calls.push({ action: "tab-update", tabId: id, properties: clone(properties) });
        if (Object.hasOwn(tabStates, id) && !tabStates[id]) throw new Error("Tab no longer exists");
        tabStates[id] = { ...(tabStates[id] || { id, url: tabUrl, autoDiscardable }), ...clone(properties) };
        return { id, ...tabStates[id] };
      },
      async query() { return []; },
      async sendMessage(tabId, message) { calls.push({ action: "tab-message", tabId, message: clone(message) });
        return message.type === "KAI_TRACKER_SEARCH_CONTEXT" ? { ok: true, result: searchContexts[tabId] || searchContext } : { ok: true }; },
      onRemoved: { addListener(listener) { tabRemovedListeners.push(listener); } }
    },
    commands: { onCommand: { addListener() {} } },
    scripting: { async executeScript(options) {
      const tabId = options.target?.tabId;
      calls.push({ action: "execute-script", tabId, target: clone(options.target), args: clone(options.args) });
      if (!options.target?.frameIds) return;
      if (injectionError) throw injectionError;
      if (Object.hasOwn(tabStates, tabId) && !tabStates[tabId]) throw new Error("Tab no longer exists");
      if (Object.hasOwn(injectionResults, tabId)) return clone(injectionResults[tabId]);
      return [{ frameId: 0, documentId: tabStates[tabId]?.documentId || `document-${tabId}`, result: tabStates[tabId]?.url || tabUrl }];
    } }
  };
  const context = vm.createContext({
    chrome,
    URL,
    console,
    crypto: require("node:crypto").webcrypto,
    AbortSignal,
    AbortController,
    TextEncoder,
    TextDecoder,
    fetch: async (url, options) => {
      if (/^https:\/\/www\.linkedin\.com\/jobs\/view\//u.test(String(url))) {
        calls.push({ action: "description-fetch", url, options });
        if (descriptionFetch) return descriptionFetch(url, options);
        throw new Error("Unexpected description request");
      }
      if (/\/job-research\/[a-f0-9-]{36}\/save-claim$/u.test(String(url))) {
        const body = JSON.parse(options.body);
        calls.push({ action: "save-claim", operation: body.action, destination: body.destination });
        assert.equal(options.method, "POST");
        assert.equal(body.destination, "applicantally-file:00000000-0000-0000-0000-000000000001");
        assert.ok(["acquire", "settle"].includes(body.action));
        return { ok: true, json: async () => body.action === "acquire"
          ? { acquired: true, token: require("node:crypto").randomUUID() } : { settled: true } };
      }
      if (researchFetch) return researchFetch(url, options);
      throw new Error("Unexpected research request");
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    importScripts() {},
    KaiLocalStoreClient: { create() { return client; } }
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/capture-policy.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/profile-routing.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/research-client.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/failure-reports.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/job-collector.js"), "utf8"), context);
  vm.runInContext(BANNED, context);
  context.KaiFlowBannedCompanies = {
    ...context.KaiFlowBannedCompanies,
    create() {
      return {
        async list() { return [...banned]; },
        async set(values) { banned = [...values]; return [...banned]; },
        async has(company) { return banned.some((value) => context.KaiFlowBannedCompanies.key(value) === context.KaiFlowBannedCompanies.key(company)); }
      };
    }
  };
  vm.runInContext(BACKGROUND, context, { filename: "src/background.js" });

  async function send(message, kind = "linkedin") {
    const result = await sendRaw(message, kind);
    assert.equal(result.handled, true);
    return result.response;
  }

  async function sendRaw(message, kind = "linkedin", overrides = {}) {
    const base = kind === "popup"
      ? { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") }
      : kind === "linkedin" ? { id: chrome.runtime.id, url: "https://www.linkedin.com/jobs/search-results/" }
        : { id: chrome.runtime.id, url: "https://example.test/" };
    const sender = { ...base, ...overrides };
    if (/^https:\/\/(?:www\.)?jobright\.ai\/jobs\//u.test(sender.url || "")) {
      const tabId = sender.tab?.id ?? 9;
      Object.assign(sender, { frameId: 0, documentId: `document-${tabId}`, documentLifecycle: "active", ...overrides });
    }
    let handled;
    const response = await new Promise((resolve) => {
      handled = messageListeners[0](message, sender, resolve);
      if (handled === undefined) resolve(undefined);
    });
    return { handled, response };
  }

  return { calls, send, sendRaw, stored, sessionStored, context, chrome, timers, tabStates,
    removeTab(tabId) { tabStates[tabId] = null; for (const listener of tabRemovedListeners) listener(tabId); } };
}

function collections(h) { return h.sessionStored[COLLECTIONS_KEY] || []; }
function collection(h, tabId) { return collections(h).find(state => tabId === undefined || state.tabId === tabId) || null; }

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const jobrightId = "6ad79ccb52aa6152bb69d5cd";
const jobrightUrl = `https://jobright.ai/jobs/info/${jobrightId}`;
const jobrightFilters = 'jobright:[["country","United States"],["workModel","Remote"]]';
const jobrightJob = { ...engineeringJob, jobId: jobrightId, sourceUrl: jobrightUrl, searchContextKey: jobrightFilters,
  selectedRegion: "us", selectedRegionSource: "search-control" };

test("Jobright collector freezes committed search filters and validates source IDs before claiming jobs", async () => {
  const h = harness({ tabUrl: jobrightUrl, searchContext: { filterKey: jobrightFilters, selectedRegion: "us", selectedRegionSource: "search-control" },
    researchFetch: async () => { throw new Error("offline"); }, profiles: ["kevin", "jagjeet"] });
  await settle();
  const tab = { id: 9, url: jobrightUrl };
  await h.context.toggleJobCollection(tab);
  const state = collection(h);
  assert.equal(state.filterKey, jobrightFilters);
  assert.equal(state.searchKey, "https://jobright.ai/jobs/recommend");
  assert.equal(h.calls.find(c => c.message?.type === "KAI_TRACKER_RUN_START").message.state.filterKey, jobrightFilters);
  const send = job => h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId: state.id }, "foreign", { url: jobrightUrl, tab });
  assert.equal((await send({ ...jobrightJob, searchContextKey: "changed-filter" })).response.ok, false);
  assert.equal((await send({ ...jobrightJob, jobId: "123" })).response.ok, false);
  assert.equal((await send({ ...jobrightJob, jobId: "6ad79ccb52aa6152bb69d5ce" })).response.ok, false);
  assert.deepEqual(collection(h).visited, []);
  const accepted = await send(jobrightJob);
  assert.equal(accepted.response.ok, true); assert.equal(accepted.response.result.queued, true);
  assert.deepEqual(collection(h).visited, [jobrightId]);
  assert.equal(h.stored.jobTrackerResearchV1[0].job.isEasyApply, true);
  assert.equal(h.stored.jobTrackerResearchV1[0].job.selectedRegion, "us");
  const checkpoint = await h.sendRaw({ type: "KAI_TRACKER_RUN_CHECKPOINT", runId: state.id,
    state: { visited: [jobrightId], pages: [jobrightId], counts: { saved: 0, researching: 1, skipped: 0 } } }, "foreign", { url: jobrightUrl, tab });
  assert.equal(checkpoint.response.ok, true);
  const badCheckpoint = await h.sendRaw({ type: "KAI_TRACKER_RUN_CHECKPOINT", runId: state.id,
    state: { visited: ["123"], pages: [], counts: { saved: 0, researching: 1, skipped: 0 } } }, "foreign", { url: jobrightUrl, tab });
  assert.equal(badCheckpoint.response.ok, false);
});

test("Jobright collector cannot start until a committed country filter is readable", async () => {
  const h = harness({ tabUrl: jobrightUrl }); await settle();
  await h.context.toggleJobCollection({ id: 9, url: jobrightUrl });
  assert.equal(collection(h), null);
  assert.equal(h.calls.some(c => c.message?.type === "KAI_TRACKER_RUN_START"), false);
});

test("Jobright query-bearing searches collect with the frozen filters and canonical job provenance", async () => {
  const tab = { id: 9, url: "https://jobright.ai/jobs/recommend?sort=recent" };
  const h = harness({ tabUrl: tab.url, searchContext: { filterKey: jobrightFilters, selectedRegion: "us", selectedRegionSource: "search-control" }, profiles: ["kevin", "jagjeet"] });
  await settle(); await h.context.toggleJobCollection(tab);
  const state = collection(h);
  h.tabStates[tab.id].url = `https://jobright.ai/jobs/info/${jobrightId}?sort=recent`;
  const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: jobrightJob, runId: state.id }, "foreign", { url: "https://jobright.ai/jobs/info/" + jobrightId + "?sort=recent", tab });
  assert.equal(result.response.ok, true); assert.equal(result.response.result.queued, true);
  assert.deepEqual(collection(h).visited, [jobrightId]);
});

test("Jobright captures bind to the current detail in the same top-frame document after SPA navigation", async () => {
  const previous = "https://jobright.ai/jobs/info/6ad79ccb52aa6152bb69d5ce";
  for (const initialUrl of [previous, "https://jobright.ai/jobs/recommend"]) {
    const tab = { id: 9, url: initialUrl };
    const h = harness({ tabStates: { [tab.id]: { ...tab, url: jobrightUrl, documentId: "same-jobright-document" } },
      searchContext: { filterKey: jobrightFilters, selectedRegion: "us", selectedRegionSource: "search-control" }, profiles: ["kevin", "jagjeet"] });
    await settle(); await h.context.toggleJobCollection(tab);
    const state = collection(h);
    const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: jobrightJob, runId: state.id }, "foreign",
      { url: initialUrl, tab, frameId: 0, documentId: "same-jobright-document" });
    assert.equal(result.response.ok, true, initialUrl);
    assert.equal(result.response.result.status, "researching");
    assert.equal(h.stored.jobTrackerResearchV1[0].job.sourceUrl, jobrightUrl);
    assert.deepEqual(collection(h).visited, [jobrightId]);
    const probe = h.calls.find(call => call.action === "execute-script" && call.target.frameIds);
    assert.deepEqual(probe.target, { tabId: tab.id, frameIds: [0] });
    assert.equal(h.calls.some(call => call.action === "save"), false);
  }
});

test("Jobright rejects current routes that do not identify the captured job and writes the identity failure report", async () => {
  for (const currentUrl of [
    "https://jobright.ai/jobs/info/6ad79ccb52aa6152bb69d5ce", "https://jobright.ai/jobs/recommend",
    "https://jobright.ai/profile", "https://www.linkedin.com/jobs/view/123", "https://jobright.ai.evil.test/jobs/info/" + jobrightId
  ]) {
    const h = harness({ tabUrl: currentUrl }); await settle();
    const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: jobrightJob }, "foreign", { url: jobrightUrl, tab: { id: 9 } });
    assert.equal(result.response.ok, false, currentUrl);
    assert.equal(result.response.error.code, "TRACKER_IDENTITY_MISMATCH", currentUrl);
    const report = h.calls.find(call => call.action === "failure-report")?.report;
    assert.equal(report?.error.code, "TRACKER_IDENTITY_MISMATCH", currentUrl);
    assert.equal(report.job.jobId, jobrightId);
    assert.equal(report.stage, "capture"); assert.equal(report.status, "failed");
    assert.match(report.reason, /selected job source and identity could not be verified/iu);
    assert.equal(h.calls.some(call => ["duplicate", "save", "save-claim"].includes(call.action)), false);
    assert.equal(h.stored.jobTrackerResearchV1?.length || 0, 0);
  }
});

test("Jobright refuses stale documents and malformed live-frame results before any research or save", async () => {
  const valid = { frameId: 0, documentId: "document-9", result: jobrightUrl };
  for (const frames of [
    [], null, undefined, [valid, valid], [{ ...valid, frameId: 1 }], [{ ...valid, documentId: "previous-document" }],
    [{ frameId: 0, result: jobrightUrl }], [{ frameId: 0, documentId: "document-9" }], { 0: valid, length: 1 }
  ]) {
    const h = harness({ tabUrl: jobrightUrl, injectionResults: { 9: frames } }); await settle();
    const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: jobrightJob }, "foreign", { url: jobrightUrl, tab: { id: 9 } });
    assert.equal(result.response.error?.code, "TRACKER_IDENTITY_MISMATCH", JSON.stringify(frames));
    assert.equal(h.calls.find(call => call.action === "failure-report")?.report.error.code, "TRACKER_IDENTITY_MISMATCH");
    assert.equal(h.calls.some(call => ["duplicate", "save", "save-claim"].includes(call.action)), false);
    assert.equal(h.stored.jobTrackerResearchV1?.length || 0, 0);
  }
});

test("Jobright requires an active top-frame sender document and an available live tab", async () => {
  const cases = [
    { sender: { frameId: 1 } }, { sender: { frameId: undefined } }, { sender: { documentId: "" } },
    { sender: { documentId: undefined } }, { sender: { documentId: 42 } }, { sender: { documentLifecycle: "cached" } },
    { sender: { tab: undefined } }, { sender: { tab: { id: "9" } } }, { tabStates: { 9: null } },
    { injectionError: new Error("The tab cannot be inspected") }
  ];
  for (const options of cases) {
    const h = harness({ tabUrl: jobrightUrl, tabStates: options.tabStates || {}, injectionError: options.injectionError }); await settle();
    const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: jobrightJob }, "foreign",
      { url: jobrightUrl, tab: { id: 9 }, ...options.sender });
    assert.equal(result.response.error?.code, "TRACKER_IDENTITY_MISMATCH", JSON.stringify(options.sender || options));
    assert.equal(h.calls.some(call => ["duplicate", "save", "save-claim"].includes(call.action)), false);
    assert.equal(h.stored.jobTrackerResearchV1?.length || 0, 0);
    if (options.sender?.frameId === 1) assert.equal(h.calls.some(call => call.action === "failure-report"), false);
  }
});

test("Jobright live-route verification retains foreign-source rejection and LinkedIn's existing capture behavior", async () => {
  const h = harness({ tabUrl: jobrightUrl }); await settle();
  const foreign = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: jobrightJob }, "foreign",
    { url: "https://www.linkedin.com/jobs/search-results/", tab: { id: 9 }, frameId: 0, documentId: "document-9" });
  assert.equal(foreign.response.error?.code, "TRACKER_IDENTITY_MISMATCH");
  assert.equal(h.calls.some(call => call.action === "failure-report" || call.target?.frameIds), false);
  const linkedin = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: engineeringJob }, "linkedin");
  assert.equal(linkedin.response.ok, true);
  assert.equal(linkedin.response.result.status, "researching");
  assert.equal(h.calls.some(call => call.target?.frameIds), false);
});

test("LinkedIn accepts the same document's current selected job when its sender URL retains the previous job ID", async () => {
  const currentUrl = "https://www.linkedin.com/jobs/search-results/?currentJobId=123&keywords=developer";
  const job = { ...engineeringJob, sourceUrl: currentUrl };
  for (const previousUrl of [
    "https://www.linkedin.com/jobs/search-results/?currentJobId=122&keywords=developer",
    "https://www.linkedin.com/jobs/view/122/"
  ]) {
    const h = harness({ tabStates: { 9: { url: currentUrl, documentId: "same-linkedin-document" } } });
    await settle();
    const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job }, "linkedin", {
      url: previousUrl, tab: { id: 9, url: previousUrl }, frameId: 0,
      documentId: "same-linkedin-document", documentLifecycle: "active"
    });
    assert.equal(result.response.ok, true, previousUrl);
    assert.equal(result.response.result.status, "researching");
    assert.equal(h.stored.jobTrackerResearchV1.length, 1);
    assert.equal(h.stored.jobTrackerResearchV1[0].job.jobId, "123");
    assert.equal(h.stored.jobTrackerResearchV1[0].job.sourceUrl, currentUrl);
    const probes = h.calls.filter(call => call.action === "execute-script" && call.target.frameIds);
    assert.equal(probes.length, 1);
    assert.deepEqual(probes[0].target, { tabId: 9, frameIds: [0] });
    assert.equal(h.calls.some(call => call.action === "save"), false);
  }
});

test("LinkedIn collection retains its search binding while a stale sender ID is verified against the live selected job", async () => {
  const previousUrl = "https://www.linkedin.com/jobs/search-results/?currentJobId=122&keywords=developer";
  const currentUrl = "https://www.linkedin.com/jobs/search-results/?currentJobId=123&keywords=developer";
  const tab = { id: 9, url: previousUrl };
  const h = harness({ tabStates: { 9: { url: currentUrl, documentId: "same-linkedin-document" } } });
  await settle(); await h.context.toggleJobCollection(tab);
  const run = collection(h);
  assert.ok(run);
  const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: { ...engineeringJob, sourceUrl: currentUrl }, runId: run.id }, "linkedin", {
    url: previousUrl, tab, frameId: 0, documentId: "same-linkedin-document", documentLifecycle: "active"
  });
  assert.equal(result.response.ok, true);
  assert.equal(result.response.result.status, "researching");
  assert.deepEqual(collection(h).visited, ["123"]);
  assert.equal(h.stored.jobTrackerResearchV1.length, 1);
});

test("LinkedIn stale-sender recovery rejects a live route without the exact captured job identity", async () => {
  const previousUrl = "https://www.linkedin.com/jobs/search-results/?currentJobId=122";
  const job = { ...engineeringJob, sourceUrl: "https://www.linkedin.com/jobs/search-results/?currentJobId=123" };
  for (const currentUrl of [
    "https://www.linkedin.com/jobs/search-results/?currentJobId=124",
    "https://www.linkedin.com/jobs/view/124/",
    "https://www.linkedin.com/jobs/search-results/",
    "https://www.linkedin.com/jobs/search-results/?currentJobId=not-an-id",
    "https://www.linkedin.com/jobs/search-results/?currentJobId=123&currentJobId=124",
    "https://www.linkedin.com/jobs/view/123/?currentJobId=124",
    "https://www.linkedin.com/jobs/view/not-an-id",
    "https://www.linkedin.com/feed/",
    jobrightUrl,
    "https://www.linkedin.com.evil.test/jobs/view/123/"
  ]) {
    const h = harness({ tabStates: { 9: { url: currentUrl, documentId: "same-linkedin-document" } } }); await settle();
    const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job }, "linkedin", {
      url: previousUrl, tab: { id: 9 }, frameId: 0, documentId: "same-linkedin-document", documentLifecycle: "active"
    });
    assert.equal(result.response.error?.code, "TRACKER_IDENTITY_MISMATCH", currentUrl);
    assert.equal(h.calls.find(call => call.action === "failure-report")?.report.error.code, "TRACKER_IDENTITY_MISMATCH", currentUrl);
    assert.equal(h.calls.some(call => ["duplicate", "save", "save-claim"].includes(call.action)), false, currentUrl);
    assert.equal(h.stored.jobTrackerResearchV1?.length || 0, 0, currentUrl);
  }
});

test("LinkedIn stale-sender recovery requires an active top-frame document and a single matching live probe", async () => {
  const previousUrl = "https://www.linkedin.com/jobs/search-results/?currentJobId=122";
  const currentUrl = "https://www.linkedin.com/jobs/search-results/?currentJobId=123";
  const job = { ...engineeringJob, sourceUrl: currentUrl };
  const frame = { frameId: 0, documentId: "same-linkedin-document", result: currentUrl };
  const cases = [
    { sender: { frameId: 1 } }, { sender: { frameId: undefined } },
    { sender: { documentId: "" } }, { sender: { documentId: undefined } }, { sender: { documentId: 42 } },
    { sender: { documentLifecycle: "cached" } }, { sender: { tab: undefined } }, { sender: { tab: { id: "9" } } },
    { frames: [] }, { frames: null }, { frames: [frame, frame] },
    { frames: [{ ...frame, frameId: 1 }] }, { frames: [{ ...frame, documentId: "replaced-document" }] },
    { frames: [{ frameId: 0, result: currentUrl }] }, { frames: [{ frameId: 0, documentId: "same-linkedin-document" }] },
    { frames: { 0: frame, length: 1 } }, { tabStates: { 9: null } },
    { injectionError: new Error("The live tab could not be inspected") }
  ];
  for (const options of cases) {
    const h = harness({ tabStates: options.tabStates || { 9: { url: currentUrl, documentId: "same-linkedin-document" } },
      injectionResults: Object.hasOwn(options, "frames") ? { 9: options.frames } : {}, injectionError: options.injectionError });
    await settle();
    const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job }, "linkedin", {
      url: previousUrl, tab: { id: 9 }, frameId: 0, documentId: "same-linkedin-document", documentLifecycle: "active", ...options.sender
    });
    assert.equal(result.response.error?.code, "TRACKER_IDENTITY_MISMATCH", JSON.stringify(options));
    assert.equal(h.calls.some(call => ["duplicate", "save", "save-claim"].includes(call.action)), false, JSON.stringify(options));
    assert.equal(h.stored.jobTrackerResearchV1?.length || 0, 0, JSON.stringify(options));
  }
});

test("LinkedIn live-route recovery cannot authorize a captured source URL naming another job", async () => {
  const h = harness({ tabStates: { 9: { url: "https://www.linkedin.com/jobs/search-results/?currentJobId=123", documentId: "same-linkedin-document" } } });
  await settle();
  const result = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: {
    ...engineeringJob, sourceUrl: "https://www.linkedin.com/jobs/search-results/?currentJobId=124"
  } }, "linkedin", {
    url: "https://www.linkedin.com/jobs/search-results/?currentJobId=122", tab: { id: 9 }, frameId: 0,
    documentId: "same-linkedin-document", documentLifecycle: "active"
  });
  assert.equal(result.response.error?.code, "TRACKER_IDENTITY_MISMATCH");
  assert.equal(h.calls.some(call => call.target?.frameIds || ["duplicate", "save", "save-claim"].includes(call.action)), false);
  assert.equal(h.stored.jobTrackerResearchV1?.length || 0, 0);
});

test("content captures and failure reports cannot cross LinkedIn and Jobright sender boundaries", async () => {
  const h = harness(); await settle();
  for (const [sourceUrl, job, allowed] of [
    [jobrightUrl, engineeringJob, false], [engineeringJob.sourceUrl, jobrightJob, false],
    ["https://jobright.ai/profile", jobrightJob, false], ["https://jobright.ai.evil.test/jobs/recommend", jobrightJob, false],
    [jobrightUrl, jobrightJob, true]
  ]) {
    const report = await h.sendRaw({ type: "KAI_TRACKER_NOT_SAVED", reasonCode: "DETAILS_NOT_CONFIRMED", job }, "foreign", { url: sourceUrl });
    assert.equal(report.response.ok, allowed, sourceUrl);
    if (!allowed) assert.equal((await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job }, "foreign", { url: sourceUrl })).response.ok, false);
  }
  assert.equal(h.calls.filter(c => c.action === "failure-report").length, 1);
  const mismatch = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: jobrightJob }, "foreign", { url: "https://jobright.ai/jobs/info/6ad79ccb52aa6152bb69d5ce" });
  assert.equal(mismatch.response.ok, false);
});

test("AI model and reasoning level preferences accept only trusted popup messages", async () => {
  const fetchCalls = [];
  const catalog = { models: [{ id: "session-alpha", name: "Session Alpha", reasoningEfforts: ["medium", "high", "xhigh"] }], defaultModel: "session-alpha" };
  const h = harness({ researchFetch: async (url, options) => {
    fetchCalls.push({ url, method: options.method });
    return { ok: true, json: async () => catalog };
  } });
  await settle();
  for (const type of ["KAI_TRACKER_RESEARCH_MODELS", "KAI_TRACKER_RESEARCH_MODEL_SET", "KAI_TRACKER_RESEARCH_EFFORT_SET", "KAI_TRACKER_RESEARCH_START"]) {
    for (const sender of ["linkedin", "foreign"]) {
      const { response } = await h.sendRaw({ type, model: "session-alpha" }, sender);
      assert.equal(response.ok, false); assert.equal(response.error.code, "TRACKER_FORBIDDEN");
    }
    const result = await h.sendRaw({ type, model: "session-alpha" }, "popup", { id: "another-extension" });
    assert.equal(result.response.ok, false);
  }
  assert.equal(fetchCalls.length, 0);
  assert.equal(h.stored.jobTrackerResearchModelV1, undefined);
  const options = await h.send({ type: "KAI_TRACKER_RESEARCH_MODELS" }, "popup");
  assert.equal(options.ok, true); assert.equal(options.result.models[0].name, "Session Alpha");
  const saved = await h.send({ type: "KAI_TRACKER_RESEARCH_MODEL_SET", model: "session-alpha" }, "popup");
  assert.equal(saved.result.selectedModel, "session-alpha");
  assert.equal(h.stored.jobTrackerResearchModelV1, "session-alpha");
  const effort = await h.send({ type: "KAI_TRACKER_RESEARCH_EFFORT_SET", reasoningEffort: "high" }, "popup");
  assert.equal(effort.result.selectedReasoningEffort, "high");
  assert.equal(h.stored.jobTrackerResearchEffortV1, "high");
  assert.ok(fetchCalls.every(call => call.url.endsWith("/job-research/models") && call.method === "GET"));
});

test("local skips produce readable reports without researching or inserting jobs", async () => {
  const h = harness(); await settle();
  const skipped = { ...engineeringJob, title: "Business Analyst", description: "Produce business requirements and reports." };
  const response = await h.send({ type: "KAI_TRACKER_SAVE", job: skipped }, "popup");
  assert.equal(response.result.status, "skipped");
  const report = h.calls.find(call => call.action === "failure-report").report;
  assert.equal(report.job.description, skipped.description); assert.equal(report.status, "skipped");
  assert.equal(report.stage, "local-policy"); assert.match(report.reason, /outside software engineering/);
  assert.equal(h.calls.some(call => call.action === "save" || call.action === "duplicate"), false);
});

test("pre-capture report messages enforce LinkedIn sender and active run identity", async () => {
  const h = harness(); await settle();
  const message = { type: "KAI_TRACKER_NOT_SAVED", job: { jobId: "123", company: "Acme", title: "Engineer",
    sourceUrl: "https://www.linkedin.com/jobs/view/123/", detailAvailability: "unavailable" }, reasonCode: "DETAILS_NOT_CONFIRMED" };
  for (const sender of ["popup", "foreign"]) assert.equal((await h.sendRaw(message, sender)).response.error.code, "TRACKER_FORBIDDEN");
  const tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  await h.context.toggleJobCollection(tab); const runId = collection(h).id;
  const denied = await h.sendRaw({ ...message, runId }, "linkedin", { tab: { id: 7 } });
  assert.equal(denied.response.error.code, "TRACKER_RUN_STOPPED");
  assert.equal(h.calls.some(call => call.action === "failure-report"), false);
  assert.equal((await h.sendRaw({ ...message, runId }, "linkedin", { tab })).response.ok, true);
  const report = h.calls.find(call => call.action === "failure-report").report;
  assert.equal(report.job.detailAvailability, "unavailable"); assert.equal(report.error.code, "DETAILS_NOT_CONFIRMED");
  assert.equal(report.job.description, undefined); assert.equal(h.calls.some(call => call.action === "save"), false);
});

test("closed or unverified application controls cannot reach a Sheet save", async () => {
  const h = harness(); await settle();
  for (const flags of [{ applicationsClosed: true }, { applicationsAvailable: false }]) {
    const response = await h.send({ type: "KAI_TRACKER_SAVE", job: { company: "New Company", workplaceType: "remote", isEasyApply: false, ...flags } }, "popup");
    assert.equal(response.result.status, "skipped");
  }
  assert.equal(h.calls.some((call) => call.action === "save"), false);
});

test("popup, card click, collector and shortcut all save the search-selected UK profile as Pending", async () => {
  for (const path of ["popup", "card", "collector", "shortcut"]) {
    const target = { ...engineeringJob, selectedRegion: "uk", selectedRegionSource: "search-control" };
    const h = harness({ profiles: ["kevin", "michal-stefanow-2page"], researchFetch: successfulResearch, stored: { kaiFlowSelectedProfile: "kevin" } });
    await settle();
    if (path === "shortcut") {
      const send = h.chrome.tabs.sendMessage;
      h.chrome.tabs.sendMessage = async (id, message) => message.type === "SCRAPE_LINKEDIN_JOB" ? { ok: true, data: target } : send(id, message);
      await h.context.runScrapeAndSaveShortcut({ id: 7, url: target.sourceUrl });
    } else if (path === "collector") {
      const tab = { id: 7, url: target.sourceUrl };
      await h.context.toggleJobCollection(tab);
      const runId = collection(h).id;
      const response = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: target, runId }, "linkedin", { tab });
      assert.equal(response.response.ok, true);
    } else {
      const response = await h.send({ type: path === "popup" ? "KAI_TRACKER_SAVE" : "KAI_TRACKER_CAPTURE", job: target, profile: "kevin" }, path === "popup" ? "popup" : "linkedin");
      assert.equal(response.ok, true);
    }
    await vm.runInContext("researchClient.poll()", h.context);
    const saves = h.calls.filter((call) => call.action === "save");
    assert.equal(saves.length, 1, path); assert.equal(saves[0].options.profile, "michal-stefanow-2page", path);
    assert.equal(saves[0].options.trashed, undefined, path); assert.equal(h.stored.kaiFlowSelectedProfile, "kevin");
  }
});

test("all capture paths skip Business Analyst before duplicate, remote or Easy Apply research", async () => {
  const h = harness(); await settle();
  for (const [type, sender] of [["KAI_TRACKER_CAPTURE", "linkedin"], ["KAI_TRACKER_SAVE", "popup"]]) {
    for (const workplaceType of ["remote", "hybrid", "on-site"]) {
      for (const isEasyApply of [true, false]) {
        const response = await h.send({ type, job: { ...engineeringJob, title: "Business Analyst", workplaceType, isEasyApply } }, sender);
        assert.equal(response.ok, true); assert.equal(response.result.status, "skipped");
        assert.match(response.result.reason, /outside software engineering/);
      }
    }
  }
  assert.equal(h.calls.some((entry) => entry.action === "duplicate" || entry.action === "save"), false);
  assert.equal(h.stored.jobTrackerResearchV1.length, 0);
});

test("every Remote ordinary Apply role queues classification on manual and automated capture paths", async () => {
  const requests = [];
  const h = harness({ researchFetch: async (url, options) => { requests.push(JSON.parse(options.body)); return successfulResearch(url, options); } }); await settle();
  for (const [type, sender] of [["KAI_TRACKER_CAPTURE", "linkedin"], ["KAI_TRACKER_SAVE", "popup"]]) {
    for (const title of ["Senior JavaScript Engineer", ".NET Developer", "Solutions Engineer"]) {
      const response = await h.send({ type, job: { ...engineeringJob, jobId: String(requests.length + 1), title } }, sender);
      assert.equal(response.result.status, "researching");
    }
  }
  assert.equal(requests.length, 6); assert.equal(new Set(requests.map((entry) => entry.requestId)).size, 6);
  assert.equal(h.calls.some((entry) => entry.action === "save"), false);
});

test("Hybrid without fully remote wording still starts its own research request on every capture path", async () => {
  const requests = [];
  const h = harness({ researchFetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ state: "queued" }) };
  } }); await settle();
  let jobId = 0;
  for (const [type, sender] of [["KAI_TRACKER_CAPTURE", "linkedin"], ["KAI_TRACKER_SAVE", "popup"]]) {
    for (const workplaceType of ["hybrid", "on-site", "unknown"]) {
      for (const isEasyApply of [true, false]) {
        const response = await h.send({ type, job: { jobId: String(++jobId), sourceUrl: engineeringJob.sourceUrl, company: "New Company", title: "Engineer", workplaceType, isEasyApply,
          description: "Hybrid with two home-working days per week. Apply to jobs@company.com.", applicationsAvailable: true } }, sender);
        assert.equal(response.ok, true);
        assert.equal(response.result.status, "researching");
      }
    }
  }
  assert.equal(h.calls.some((call) => call.action === "save"), false);
  assert.equal(requests.length, 12);
  assert.equal(new Set(requests.map((request) => request.requestId)).size, 12);
});

test("one cached Sheet snapshot classifies every visible company and revision refreshes it", async () => {
  const h = harness({ snapshots: [
    { companies: ["Acme", "Beta"], revision: "r1" },
    { companies: [], revision: "r1", unchanged: true }
  ] });
  await settle();

  const first = await h.send({
    type: "KAI_TRACKER_CLASSIFY_COMPANIES",
    companies: [" ACME ", "Beta", "Normal", "Blocked Co"]
  });
  assert.equal(first.ok, true);
  assert.deepEqual(clone(first.result.companies), [
    { company: "ACME", banned: false, duplicate: { company: "ACME" } },
    { company: "Beta", banned: false, duplicate: { company: "Beta" } },
    { company: "Blocked Co", banned: true, duplicate: null },
    { company: "Normal", banned: false, duplicate: null }
  ]);
  assert.equal(h.calls.filter((call) => call.action === "companies").length, 1);
  assert.equal(h.calls.some((call) => call.action === "duplicate"), false);
  assert.deepEqual(h.stored[SNAPSHOT_KEY].companies, ["Acme", "Beta"]);

  const refreshed = await h.send({ type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies: ["Acme"], refresh: true });
  assert.equal(refreshed.ok, true);
  assert.equal(h.calls.filter((call) => call.action === "companies").length, 2);
  assert.deepEqual(h.calls.at(-1).options, { refresh: true, revision: "r1" });
});

test("a confirmed save updates the persistent snapshot before a later Google refresh", async () => {
  const never = () => new Promise(() => {});
  const h = harness({ snapshots: [{ companies: ["Acme"], revision: "r1" }, never], researchFetch: successfulResearch });
  await settle();

  const saved = await h.send({ type: "KAI_TRACKER_SAVE", job: engineeringJob }, "popup");
  assert.equal(saved.ok, true);
  assert.equal(saved.result.status, "researching");
  assert.equal(h.calls.some((entry) => entry.action === "save"), false);
  await vm.runInContext("researchClient.poll()", h.context);
  assert.deepEqual(h.stored[SNAPSHOT_KEY].companies, ["Acme", "New Company"]);
  assert.equal(h.stored[SNAPSHOT_KEY].revision, "");

  const classified = await h.send({ type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies: ["New Company", "Other"] });
  assert.equal(classified.ok, true);
  assert.deepEqual(clone(classified.result.companies), [
    { company: "New Company", banned: false, duplicate: { company: "New Company" } },
    { company: "Other", banned: false, duplicate: null }
  ]);
});

test("message authorization separates trusted popup writes from LinkedIn-only classification", async () => {
  const h = harness();
  await settle();
  const before = h.calls.length;

  for (const message of [
    { type: "KAI_TRACKER_CONFIGURE", credentials: { private_key: "must-not-pass" } },
    { type: "KAI_TRACKER_SAVE", job: { company: "Blocked" } },
    { type: "KAI_TRACKER_STATUS" }
  ]) {
    const denied = await h.sendRaw(message, "linkedin");
    assert.equal(denied.handled, false);
    assert.equal(denied.response.ok, false);
    assert.equal(denied.response.error.code, "TRACKER_FORBIDDEN");
  }

  const deniedClassification = await h.sendRaw({
    type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies: ["Acme"]
  }, "popup");
  assert.equal(deniedClassification.handled, false);
  assert.equal(deniedClassification.response.error.code, "TRACKER_FORBIDDEN");
  assert.equal(h.calls.length, before, "no denied message reached a client method");
});

test("collection hotkey toggles one tab run; stopped runs and other tabs cannot submit automated saves", async () => {
  const h = harness(); await settle();
  const tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  await h.context.toggleJobCollection(tab);
  const state = collection(h);
  assert.ok(state.id); assert.equal(state.tabId, tab.id);
  assert.equal(h.calls.find((entry) => entry.action === "tab-message").message.type, "KAI_TRACKER_RUN_START");
  const job = { jobId: "123", jobIdSource: "details", sourceUrl: tab.url, company: "New Company", title: "Engineer", description: "Description", workplaceType: "remote", isEasyApply: false };
  const outsider = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId: state.id }, "linkedin", { tab: { id: 7 } });
  assert.equal(outsider.response.error.code, "TRACKER_RUN_STOPPED");
  const otherState = await h.sendRaw({ type: "KAI_TRACKER_RUN_STATE" }, "linkedin", { tab: { id: 7 } });
  assert.equal(otherState.response.result.state, null);
  await h.context.toggleJobCollection(tab); assert.equal(collection(h), null);
  const late = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId: state.id }, "linkedin", { tab });
  assert.equal(late.response.error.code, "TRACKER_RUN_STOPPED");
  assert.equal(h.calls.some((entry) => entry.action === "save"), false);
  const denied = await h.sendRaw({ type: "KAI_TRACKER_RUN_STATE" }, "popup");
  assert.equal(denied.response.error.code, "TRACKER_FORBIDDEN");
});
test("automated capture claims each job durably once, including concurrent messages and worker recovery", async () => {
  const requests = [];
  const h = harness({ researchFetch: async (url, options) => { requests.push(url); return successfulResearch(url, options); } }); await settle();
  const tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  await h.context.toggleJobCollection(tab); const runId = collection(h).id;
  const job = engineeringJob;
  const results = await Promise.all([1, 2].map(() => h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId }, "linkedin", { tab })));
  assert.deepEqual(results.map((entry) => entry.response.result.status).sort(), ["researching", "skipped"]);
  assert.equal(requests.length, 1); assert.equal(h.calls.filter((entry) => entry.action === "save").length, 0);
  const resumed = harness({ sessionStored: h.sessionStored }); await settle();
  const replay = await resumed.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId }, "linkedin", { tab });
  assert.equal(replay.response.result.status, "skipped"); assert.equal(resumed.calls.some((entry) => entry.action === "save"), false);
  const changed = await resumed.sendRaw({ type: "KAI_TRACKER_RUN_STATE" }, "linkedin", { tab, url: tab.url + "?keywords=different" });
  assert.equal(changed.response.result.state, null); assert.equal(collection(resumed), null);
});
test("automated collection accepts successive offline research captures without falsely counting saved jobs", async () => {
  const requests = [];
  const h = harness({ researchFetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    throw new Error("Research worker connection refused.");
  } });
  await settle();
  const tab = { id: 42, url: engineeringJob.sourceUrl };
  await h.context.toggleJobCollection(tab);
  const runId = collection(h).id;
  for (const [jobId, company] of [["123", "First Company"], ["456", "Second Company"]]) {
    const captured = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: { ...engineeringJob, jobId, company }, runId }, "linkedin", { tab });
    assert.equal(captured.response.ok, true);
    assert.equal(captured.response.result.status, "researching"); assert.equal(captured.response.result.queued, true);
    assert.equal(captured.response.result.requestId, requests.at(-1).requestId);
  }
  const state = collection(h);
  assert.equal(state.id, runId); assert.deepEqual(state.visited, ["123", "456"]);
  assert.deepEqual(state.counts, { saved: 0, researching: 2, skipped: 0 });
  assert.equal(h.stored.jobTrackerResearchV1.length, 2);
  assert.ok(h.stored.jobTrackerResearchV1.every((record) => record.state === "requesting" && !record.terminal));
  assert.equal(new Set(requests.map((request) => request.requestId)).size, 2);
  assert.equal(h.calls.filter((entry) => entry.action === "save").length, 0);

  const replay = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job: { ...engineeringJob, company: "First Company" }, runId }, "linkedin", { tab });
  assert.equal(replay.response.result.status, "skipped"); assert.equal(requests.length, 2);
  assert.equal(collection(h).counts.researching, 2);
});
test("an uncertain automatic write remains claimed after failure and cannot be replayed on worker recovery", async () => {
  const sessionStored = {}, tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  const h = harness({ sessionStored, researchFetch: successfulResearch, saveError: Object.assign(new Error("Unconfirmed write"), { code: "TRACKER_SAVE_UNCONFIRMED" }) }); await settle();
  await h.context.toggleJobCollection(tab); const runId = collection({ sessionStored }).id;
  const job = engineeringJob;
  const queued = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId }, "linkedin", { tab });
  assert.equal(queued.response.result.status, "researching");
  await vm.runInContext("researchClient.poll()", h.context);
  assert.equal(h.stored.jobTrackerResearchV1[0].state, "save-unconfirmed"); assert.deepEqual(collection({ sessionStored }).visited, ["123"]);
  assert.equal(h.calls.filter((entry) => entry.action === "save").length, 1);
  const recovered = harness({ sessionStored, stored: h.stored }); await settle();
  const again = await recovered.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId }, "linkedin", { tab });
  assert.equal(again.response.result.status, "skipped"); assert.equal(recovered.calls.some((entry) => entry.action === "save"), false);
});

test("background waits are bound to the owner and cancel immediately on the emergency shortcut from an unsupported tab", async () => {
  const h = harness(); await settle();
  const tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  await h.context.toggleJobCollection(tab);
  const runId = collection(h).id;
  const outsider = await h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 20_000 }, "linkedin", { tab: { id: 7 } });
  assert.equal(outsider.response.result.stopped, true);
  const invalid = await h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 30_000 }, "linkedin", { tab });
  assert.equal(invalid.response.ok, false);
  const waiting = h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 20_000 }, "linkedin", { tab });
  await settle();
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 20_000));
  await h.context.toggleJobCollection({ id: 7, url: "https://example.test/" });
  assert.equal((await waiting).response.result.stopped, true);
  assert.equal(collection(h), null);
  assert.equal([...h.timers.values()].some((timer) => timer.delay === 20_000), false);
  assert.deepEqual(h.calls.filter((entry) => entry.action === "tab-update").map((entry) => entry.properties),
    [{ autoDiscardable: false }, { autoDiscardable: true }]);
});

test("worker delay completion rechecks run ownership and preserves an existing no-discard preference", async () => {
  const h = harness({ autoDiscardable: false }); await settle();
  const tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  await h.context.toggleJobCollection(tab);
  const runId = collection(h).id;
  const waiting = h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 250 }, "linkedin", { tab });
  await settle();
  const pending = [...h.timers.values()].find((timer) => timer.delay === 250);
  pending.callback();
  assert.equal((await waiting).response.result.stopped, false);
  await h.context.stopActiveCollection();
  assert.ok(h.calls.filter((entry) => entry.action === "tab-update").every((entry) => entry.properties.autoDiscardable === false));
  assert.ok(h.calls.filter((entry) => entry.action === "tab-update").every((entry) => !Object.hasOwn(entry.properties, "active")));
});

test("a new document after Next replaces the old document's pending delay without losing the run", async () => {
  const h = harness(); await settle();
  const tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  await h.context.toggleJobCollection(tab);
  const runId = collection(h).id;
  const oldWait = h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 250 }, "linkedin", { tab, documentId: "old-page" });
  await settle();
  const newWait = h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 200 }, "linkedin", { tab, documentId: "new-page" });
  await settle();
  assert.equal((await oldWait).response.result.stopped, true);
  assert.equal(collection(h).id, runId);
  const pending = [...h.timers.values()].find((timer) => timer.delay === 200);
  pending.callback();
  assert.equal((await newWait).response.result.stopped, false);
  await h.context.stopActiveCollection();
});

const linkedinTab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/?keywords=backend&location=United+States" };
const jobrightTab = { id: 9, url: jobrightUrl };
const usSearchContext = { filterKey: jobrightFilters, selectedRegion: "us", selectedRegionSource: "search-control" };

async function dualCollectorHarness(options = {}) {
  const h = harness({ profiles: ["kevin", "jagjeet"], researchFetch: async () => { throw new Error("offline"); },
    tabStates: { [linkedinTab.id]: { ...linkedinTab, autoDiscardable: true }, [jobrightTab.id]: { ...jobrightTab, autoDiscardable: false } },
    searchContexts: { [jobrightTab.id]: usSearchContext }, ...options });
  await settle();
  await Promise.all([h.context.toggleJobCollection(linkedinTab), h.context.toggleJobCollection(jobrightTab)]);
  assert.equal(collections(h).length, 2);
  return h;
}

function sendFromTab(h, tab, message, overrides = {}) {
  return h.sendRaw(message, "foreign", { url: tab.url, tab, ...overrides });
}

test("LinkedIn and Jobright collect simultaneously with independent durable claims and research counts", async () => {
  const h = await dualCollectorHarness();
  const liRun = collection(h, linkedinTab.id), jrRun = collection(h, jobrightTab.id);
  assert.notEqual(liRun.id, jrRun.id);
  assert.equal(jrRun.filterKey, jobrightFilters);
  const liJob = { ...engineeringJob, sourceUrl: linkedinTab.url, selectedRegion: "us", selectedRegionSource: "search-control" };
  const jrJob = { ...jobrightJob, company: "Jobright Company" };
  const outcomes = await Promise.all([
    sendFromTab(h, linkedinTab, { type: "KAI_TRACKER_CAPTURE", job: liJob, runId: liRun.id }),
    sendFromTab(h, jobrightTab, { type: "KAI_TRACKER_CAPTURE", job: jrJob, runId: jrRun.id })
  ]);
  assert.ok(outcomes.every(outcome => outcome.response.ok && outcome.response.result.queued));
  assert.deepEqual(collection(h, linkedinTab.id).visited, [liJob.jobId]);
  assert.deepEqual(collection(h, jobrightTab.id).visited, [jrJob.jobId]);
  assert.deepEqual(collection(h, linkedinTab.id).counts, { saved: 0, researching: 1, skipped: 0 });
  assert.deepEqual(collection(h, jobrightTab.id).counts, { saved: 0, researching: 1, skipped: 0 });
  assert.equal(h.stored.jobTrackerResearchV1.length, 2);
  assert.deepEqual(h.stored.jobTrackerResearchV1.map(record => record.tabId).sort((a, b) => a - b), [9, 42]);
  assert.equal(h.calls.some(call => call.message?.type === "KAI_TRACKER_RUN_STOP"), false);
  for (const [tab, run, job] of [[linkedinTab, liRun, liJob], [jobrightTab, jrRun, jrJob]]) {
    const replay = await sendFromTab(h, tab, { type: "KAI_TRACKER_CAPTURE", job, runId: run.id });
    assert.equal(replay.response.result.status, "skipped");
    const state = await sendFromTab(h, tab, { type: "KAI_TRACKER_RUN_STATE" });
    assert.equal(state.response.result.state.id, run.id);
  }
  assert.equal(h.stored.jobTrackerResearchV1.length, 2);
});

test("simultaneous approved LinkedIn and Jobright captures save with their own US experience-selected profiles", async () => {
  const submitted = new Map();
  const evidence = { linkedin: "5+ years of professional software engineering experience required.",
    jobright: "3 years of professional software engineering experience required." };
  const h = await dualCollectorHarness({ researchFetch: async (url, options) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body); submitted.set(body.requestId, body.job);
      return { ok: true, json: async () => ({ state: "queued" }) };
    }
    const job = submitted.get(String(url).split("/").at(-1));
    assert.ok(job, "only captured jobs are researched");
    const isJobright = job.sourceUrl.startsWith("https://jobright.ai/");
    return { ok: true, json: async () => ({ state: "completed", completedAt: new Date().toISOString(), result: {
      decision: "save", company: job.company, title: job.title,
      role: { eligible: true, category: "software-development", evidence: duties },
      experience: { minimumYears: isJobright ? 3 : 5, scope: isJobright ? "senior" : "ordinary", evidence: isJobright ? evidence.jobright : evidence.linkedin },
      application: { url: `https://careers.example.com/jobs/${isJobright ? "jobright-three" : "linkedin-five"}`, company: job.company,
        title: job.title, applicationsOpen: true, free: true, evidence: "Open application form observed with submit button." }
    } }) };
  } });
  const liJob = { ...engineeringJob, sourceUrl: linkedinTab.url, company: "US LinkedIn Five", title: "Software Engineer",
    description: `${duties} ${evidence.linkedin}`, selectedRegion: "us", selectedRegionSource: "search-control" };
  const jrJob = { ...jobrightJob, company: "US Jobright Three", title: "Senior Software Engineer", description: `${duties} ${evidence.jobright}` };
  const captures = await Promise.all([[linkedinTab, liJob], [jobrightTab, jrJob]].map(([tab, job]) =>
    sendFromTab(h, tab, { type: "KAI_TRACKER_CAPTURE", job, runId: collection(h, tab.id).id })));
  assert.ok(captures.every(capture => capture.response.ok && capture.response.result.status === "researching"));
  await vm.runInContext("researchClient.poll()", h.context);
  const saves = h.calls.filter(call => call.action === "save");
  assert.equal(saves.length, 2);
  assert.equal(saves.find(call => call.company === liJob.company).options.profile, "kevin");
  assert.equal(saves.find(call => call.company === jrJob.company).options.profile, "jagjeet");
  assert.ok(saves.every(call => call.options.trashed === undefined));
  assert.deepEqual(new Set(saves.map(call => call.options.requestId)), new Set(captures.map(capture => capture.response.result.requestId)));
  assert.ok(h.stored.jobTrackerResearchV1.every(record => record.state === "saved" && record.terminal));
  assert.equal(h.calls.filter(call => call.action === "save-claim" && call.operation === "acquire").length, 2);
  assert.equal(h.calls.filter(call => call.action === "save-claim" && call.operation === "settle").length, 2);
  assert.equal(collections(h).length, 2);
});

test("two active runs reject cross-tab run IDs and checkpoints without changing either history", async () => {
  const h = await dualCollectorHarness();
  const liRun = collection(h, linkedinTab.id), jrRun = collection(h, jobrightTab.id);
  const before = clone(collections(h));
  for (const [tab, other, job] of [[linkedinTab, jrRun, { ...engineeringJob, sourceUrl: linkedinTab.url }], [jobrightTab, liRun, jobrightJob]]) {
    const capture = await sendFromTab(h, tab, { type: "KAI_TRACKER_CAPTURE", job, runId: other.id });
    assert.equal(capture.response.error.code, "TRACKER_RUN_STOPPED");
    const wait = await sendFromTab(h, tab, { type: "KAI_TRACKER_RUN_WAIT", runId: other.id, milliseconds: 250 });
    assert.equal(wait.response.result.stopped, true);
    const checkpoint = await sendFromTab(h, tab, { type: "KAI_TRACKER_RUN_CHECKPOINT", runId: other.id,
      state: { visited: [job.jobId], pages: [], counts: { saved: 99, researching: 0, skipped: 0 } } });
    assert.equal(checkpoint.response.result.stopped, true);
    const end = await sendFromTab(h, tab, { type: "KAI_TRACKER_RUN_END", runId: other.id });
    assert.equal(end.response.result.stopped, true);
  }
  assert.deepEqual(collections(h), before);
  assert.equal(h.stored.jobTrackerResearchV1.length, 0);
});

test("the shortcut stops only its own tab and preserves the other run's wait, checkpoints and discard preference", async () => {
  const h = await dualCollectorHarness();
  const liRun = collection(h, linkedinTab.id), jrRun = collection(h, jobrightTab.id);
  const liWait = sendFromTab(h, linkedinTab, { type: "KAI_TRACKER_RUN_WAIT", runId: liRun.id, milliseconds: 251 });
  const jrWait = sendFromTab(h, jobrightTab, { type: "KAI_TRACKER_RUN_WAIT", runId: jrRun.id, milliseconds: 252 });
  await settle();
  await h.context.toggleJobCollection(linkedinTab);
  assert.equal((await liWait).response.result.stopped, true);
  assert.equal(collection(h, linkedinTab.id), null);
  assert.equal(collection(h, jobrightTab.id).id, jrRun.id);
  const jrTimer = [...h.timers.values()].find(timer => timer.delay === 252);
  assert.ok(jrTimer, "the second tab's delay remains pending");
  jrTimer.callback();
  assert.equal((await jrWait).response.result.stopped, false);
  const checkpoint = await sendFromTab(h, jobrightTab, { type: "KAI_TRACKER_RUN_CHECKPOINT", runId: jrRun.id,
    state: { visited: [jobrightId], pages: ["page-1"], counts: { saved: 0, researching: 1, skipped: 0 } } });
  assert.equal(checkpoint.response.result.state.id, jrRun.id);
  assert.deepEqual(collection(h, jobrightTab.id).visited, [jobrightId]);
  assert.deepEqual(h.calls.filter(call => call.message?.type === "KAI_TRACKER_RUN_STOP").map(call => call.tabId), [linkedinTab.id]);
  assert.equal(h.tabStates[linkedinTab.id].autoDiscardable, true);
  assert.equal(h.tabStates[jobrightTab.id].autoDiscardable, false);
  const stale = await sendFromTab(h, linkedinTab, { type: "KAI_TRACKER_CAPTURE", job: { ...engineeringJob, sourceUrl: linkedinTab.url }, runId: liRun.id });
  assert.equal(stale.response.error.code, "TRACKER_RUN_STOPPED");
});

test("a third automatic collector is rejected without stopping or resetting either active run", async () => {
  const third = { id: 77, url: "https://www.linkedin.com/jobs/search-results/?keywords=java" };
  const h = await dualCollectorHarness();
  h.tabStates[third.id] = { ...third, autoDiscardable: true };
  const before = clone(collections(h));
  await h.context.toggleJobCollection(third);
  assert.deepEqual(collections(h), before);
  assert.equal(h.calls.filter(call => call.message?.type === "KAI_TRACKER_RUN_START").length, 2);
  assert.equal(h.calls.some(call => call.message?.type === "KAI_TRACKER_RUN_STOP"), false);
  assert.equal(h.tabStates[third.id].autoDiscardable, true);
  assert.ok(h.calls.some(call => call.action === "execute-script" && call.tabId === third.id && /two|2/i.test(call.args?.[0])), "the limit is explained in the third tab");
});

test("an invalid Jobright country or failed second-tab controls leave the first collector running", async () => {
  for (const failure of ["country", "controls"]) {
    const h = harness({ tabStates: { [linkedinTab.id]: { ...linkedinTab, autoDiscardable: true }, [jobrightTab.id]: { ...jobrightTab, autoDiscardable: true } },
      searchContexts: { [jobrightTab.id]: failure === "country" ? { ...usSearchContext, selectedRegion: "uk" } : usSearchContext } });
    await settle();
    await h.context.toggleJobCollection(linkedinTab);
    const first = clone(collection(h, linkedinTab.id));
    const original = h.chrome.tabs.sendMessage;
    if (failure === "controls") h.chrome.tabs.sendMessage = async (tabId, message) =>
      tabId === jobrightTab.id && message.type === "KAI_TRACKER_RUN_START" ? { ok: false, error: "Unable to start controls" } : original(tabId, message);
    await h.context.toggleJobCollection(jobrightTab);
    assert.deepEqual(collections(h), [first], failure);
    assert.equal(h.tabStates[linkedinTab.id].autoDiscardable, false, failure);
    assert.equal(h.tabStates[jobrightTab.id].autoDiscardable, true, failure);
    assert.equal(h.calls.some(call => call.message?.type === "KAI_TRACKER_RUN_STOP" && call.tabId === linkedinTab.id), false, failure);
    const state = await sendFromTab(h, linkedinTab, { type: "KAI_TRACKER_RUN_STATE" });
    assert.equal(state.response.result.state.id, first.id, failure);
  }
});

test("ending or closing one collector never clears its peer or restores the peer's discard setting", async () => {
  for (const reason of ["end", "close"]) {
    const h = await dualCollectorHarness();
    const liRun = collection(h, linkedinTab.id), jrRun = collection(h, jobrightTab.id);
    const before = h.calls.length;
    if (reason === "end") {
      const result = await sendFromTab(h, linkedinTab, { type: "KAI_TRACKER_RUN_END", runId: liRun.id });
      assert.equal(result.response.result.stopped, true);
    } else { h.removeTab(linkedinTab.id); await settle(); }
    assert.equal(collection(h, linkedinTab.id), null, reason);
    assert.equal(collection(h, jobrightTab.id).id, jrRun.id, reason);
    assert.equal(h.calls.slice(before).some(call => call.action === "tab-update" && call.tabId === jobrightTab.id), false, reason);
    const peer = await sendFromTab(h, jobrightTab, { type: "KAI_TRACKER_RUN_STATE" });
    assert.equal(peer.response.result.state.id, jrRun.id);
  }
});

test("a changed search invalidates only that tab while worker recovery preserves the other run", async () => {
  const h = await dualCollectorHarness();
  const liRun = collection(h, linkedinTab.id), jrRun = collection(h, jobrightTab.id);
  const resumed = harness({ stored: h.stored, sessionStored: h.sessionStored, tabStates: clone(h.tabStates), searchContexts: { [jobrightTab.id]: usSearchContext } });
  await settle();
  assert.equal(collections(resumed).length, 2);
  assert.equal(collection(resumed, linkedinTab.id).id, liRun.id);
  assert.equal(collection(resumed, jobrightTab.id).id, jrRun.id);
  const changed = await sendFromTab(resumed, linkedinTab, { type: "KAI_TRACKER_RUN_STATE" }, { url: linkedinTab.url + "&f_TPR=r86400" });
  assert.equal(changed.response.result.state, null);
  assert.equal(collection(resumed, linkedinTab.id), null);
  assert.equal(collection(resumed, jobrightTab.id).id, jrRun.id);
  assert.equal(resumed.tabStates[linkedinTab.id].autoDiscardable, true);
  assert.equal(resumed.tabStates[jobrightTab.id].autoDiscardable, false);
});

test("worker recovery removes a missing tab's run and keeps the other collector available", async () => {
  const h = await dualCollectorHarness();
  const jrRun = clone(collection(h, jobrightTab.id));
  const resumed = harness({ sessionStored: h.sessionStored,
    tabStates: { [linkedinTab.id]: null, [jobrightTab.id]: clone(h.tabStates[jobrightTab.id]) } });
  await settle();
  assert.deepEqual(collections(resumed), [jrRun]);
  const peer = await sendFromTab(resumed, jobrightTab, { type: "KAI_TRACKER_RUN_STATE" });
  assert.equal(peer.response.result.state.id, jrRun.id);
  assert.equal(resumed.calls.some(call => call.message?.type === "KAI_TRACKER_RUN_STOP" && call.tabId === jobrightTab.id), false);
});

test("new documents replace only their own pending wait when both collectors are running", async () => {
  const h = await dualCollectorHarness();
  const liRun = collection(h, linkedinTab.id), jrRun = collection(h, jobrightTab.id);
  const oldWait = sendFromTab(h, linkedinTab, { type: "KAI_TRACKER_RUN_WAIT", runId: liRun.id, milliseconds: 251 }, { documentId: "old-document" });
  const peerWait = sendFromTab(h, jobrightTab, { type: "KAI_TRACKER_RUN_WAIT", runId: jrRun.id, milliseconds: 252 }, { documentId: "jobright-document" });
  await settle();
  const newWait = sendFromTab(h, linkedinTab, { type: "KAI_TRACKER_RUN_WAIT", runId: liRun.id, milliseconds: 253 }, { documentId: "new-document" });
  await settle();
  assert.equal((await oldWait).response.result.stopped, true);
  assert.equal(collections(h).length, 2);
  for (const delay of [252, 253]) { const timer = [...h.timers.values()].find(item => item.delay === delay); assert.ok(timer); timer.callback(); }
  assert.equal((await peerWait).response.result.stopped, false);
  assert.equal((await newWait).response.result.stopped, false);
});

test("settings changes and the emergency shortcut stop both collectors and cancel both waits", async () => {
  for (const reason of ["configure", "clear", "emergency"]) {
    const h = await dualCollectorHarness();
    const waits = [linkedinTab, jobrightTab].map((tab, index) => sendFromTab(h, tab, { type: "KAI_TRACKER_RUN_WAIT", runId: collection(h, tab.id).id, milliseconds: 251 + index }));
    await settle();
    if (reason === "emergency") await h.context.toggleJobCollection({ id: 77, url: "https://example.test/" });
    else {
      const result = await h.send({ type: reason === "configure" ? "KAI_TRACKER_CONFIGURE" : "KAI_TRACKER_CLEAR_CONFIG" }, "popup");
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    assert.ok((await Promise.all(waits)).every(result => result.response.result.stopped), reason);
    assert.deepEqual(collections(h), [], reason);
    assert.equal(h.tabStates[linkedinTab.id].autoDiscardable, true, reason);
    assert.equal(h.tabStates[jobrightTab.id].autoDiscardable, false, reason);
    assert.deepEqual(h.calls.filter(call => call.message?.type === "KAI_TRACKER_RUN_STOP").map(call => call.tabId).sort((a, b) => a - b), [9, 42], reason);
  }
});

test("legacy single-run state migrates once with the same identity, history and discard preference", async () => {
  const legacy = { id: "legacy-run", tabId: linkedinTab.id, searchKey: "https://www.linkedin.com/jobs/search-results/?keywords=backend&location=United+States",
    originalAutoDiscardable: true, visited: ["123"], pages: ["first-page"], counts: { saved: 0, researching: 1, skipped: 0 } };
  const sessionStored = { jobTrackerCollectionV1: clone(legacy) };
  const h = harness({ sessionStored, tabStates: { [linkedinTab.id]: clone(linkedinTab) } });
  await settle();
  assert.deepEqual(collections(h), [legacy]);
  assert.ok(!sessionStored.jobTrackerCollectionV1, "the legacy key cannot resurrect a stopped run");
  const own = await sendFromTab(h, linkedinTab, { type: "KAI_TRACKER_RUN_STATE" });
  assert.equal(own.response.result.state.id, legacy.id);
  await h.context.toggleJobCollection(linkedinTab);
  assert.deepEqual(collections(h), []);
  const resumed = harness({ sessionStored, tabStates: { [linkedinTab.id]: clone(linkedinTab) } });
  await settle();
  assert.deepEqual(collections(resumed), []);
});

test("an existing empty V2 state does not resurrect stale legacy collection data", async () => {
  const sessionStored = { [COLLECTIONS_KEY]: [], jobTrackerCollectionV1: { id: "stale", tabId: linkedinTab.id, searchKey: linkedinTab.url } };
  const h = harness({ sessionStored, tabStates: { [linkedinTab.id]: clone(linkedinTab) } });
  await settle();
  assert.deepEqual(collections(h), []);
  const state = await sendFromTab(h, linkedinTab, { type: "KAI_TRACKER_RUN_STATE" });
  assert.equal(state.response.result.state, null);
});

const descriptionUrl = "https://www.linkedin.com/jobs/search-results/?keywords=backend&location=United+States&currentJobId=123";
const descriptionSender = { url: descriptionUrl, tab: { id: 9 }, frameId: 0, documentId: "description-document", documentLifecycle: "active" };
const descriptionJob = { ...engineeringJob, sourceUrl: descriptionUrl };
const descriptionHtml = `<html><head><title>New Company hiring Senior JavaScript Engineer | LinkedIn</title></head><body><h1>Senior JavaScript Engineer</h1><a>New Company</a><div class="show-more-less-html__markup">${duties}</div><a>Sign in</a></body></html>`;
function publicHtmlResponse({ url = "https://www.linkedin.com/jobs/view/123/", html = descriptionHtml, status = 200,
  contentType = "text/html; charset=utf-8", contentLength, chunks } = {}) {
  let index = 0;
  return { status, url, headers: { get(name) { return name === "content-type" ? contentType : name === "content-length" ? contentLength ?? null : null; } },
    text: async () => html,
    ...(chunks ? { body: { getReader() { return { read: async () => index < chunks.length ? { value: chunks[index++], done: false } : { done: true },
      async cancel() {}, releaseLock() {} }; } } } : {}) };
}
function descriptionHarness(options = {}) {
  return harness({ tabUrl: descriptionUrl, tabStates: { 9: { url: descriptionUrl, documentId: descriptionSender.documentId } },
    descriptionFetch: async () => publicHtmlResponse(), ...options });
}
async function requestDescription(h, { job = descriptionJob, runId } = {}, sender = {}) {
  return (await h.sendRaw({ type: "KAI_TRACKER_DESCRIPTION", job, ...(runId ? { runId } : {}) }, "linkedin", { ...descriptionSender, ...sender })).response;
}
function assertDescriptionReadOnly(h) {
  assert.equal(h.calls.some(call => ["duplicate", "save", "save-claim", "failure-report"].includes(call.action)), false);
  assert.equal(h.stored.jobTrackerResearchV1?.length || 0, 0);
}

test("public description fetch uses only the numeric LinkedIn public URL without credentials and returns bounded HTML", async () => {
  const chunks = [descriptionHtml.slice(0, 82), descriptionHtml.slice(82)].map(text => new TextEncoder().encode(text));
  const h = descriptionHarness({ descriptionFetch: async () => publicHtmlResponse({ chunks }) });
  await settle();
  const response = await requestDescription(h);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(clone(response.result), { jobId: "123", sourceUrl: "https://www.linkedin.com/jobs/view/123/", html: descriptionHtml });
  const request = h.calls.find(call => call.action === "description-fetch");
  assert.equal(request.url, "https://www.linkedin.com/jobs/view/123/");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "follow");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.headers.Accept, "text/html");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 20_000), false);
  assert.equal(h.calls.filter(call => call.target?.frameIds).length, 2, "live document is verified before and after fetching");
  assertDescriptionReadOnly(h);
});

test("public description accepts a strict same-job slug redirect and omits its tracking parameters", async () => {
  const h = descriptionHarness({ descriptionFetch: async () => publicHtmlResponse({ url: "https://www.linkedin.com/jobs/view/senior-engineer-at-new-company-123/?trackingId=public-tracking#details" }) });
  await settle();
  const response = await requestDescription(h, {}, { url: descriptionUrl.replace("currentJobId=123", "currentJobId=456") });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.sourceUrl, "https://www.linkedin.com/jobs/view/senior-engineer-at-new-company-123/");
  assertDescriptionReadOnly(h);
});

test("public description is unavailable to foreign, popup, Jobright, subframe and inactive or replaced documents", async () => {
  const cases = [
    { sender: { url: "https://example.test/jobs/123" } },
    { sender: { url: "chrome-extension://extension-id/popup.html" } },
    { sender: { url: jobrightUrl }, job: jobrightJob },
    { sender: { id: "another-extension" } },
    { sender: { frameId: 1 } },
    { sender: { frameId: undefined } },
    { sender: { documentId: "" } },
    { sender: { documentId: "replaced-document" } },
    { sender: { documentLifecycle: "cached" } },
    { sender: { tab: undefined } }
  ];
  for (const item of cases) {
    const h = descriptionHarness(); await settle();
    const response = await requestDescription(h, { job: item.job || descriptionJob }, item.sender);
    assert.equal(response.ok, false, JSON.stringify(item));
    assert.ok(["TRACKER_FORBIDDEN", "TRACKER_IDENTITY_MISMATCH"].includes(response.error.code), JSON.stringify(response));
    assert.equal(h.calls.some(call => call.action === "description-fetch"), false, JSON.stringify(item));
    assertDescriptionReadOnly(h);
  }
});

test("public description rechecks an explicit live selected ID even when the sender URL already matches", async () => {
  const cases = [
    { live: descriptionUrl.replace("currentJobId=123", "currentJobId=456") },
    { live: "https://www.linkedin.com/jobs/search-results/?keywords=backend" },
    { live: "https://www.linkedin.com/jobs/search-results/?currentJobId=123&currentJobId=456" },
    { live: "https://example.test/jobs/view/123/" },
    { live: "https://www.linkedin.com/jobs/view/not-a-numeric-id/" },
    { job: { ...descriptionJob, sourceUrl: descriptionUrl.replace("currentJobId=123", "currentJobId=456") } },
    { job: { ...descriptionJob, jobId: "123/external" } },
    { injectionResults: { 9: [{ frameId: 0, documentId: descriptionSender.documentId, result: descriptionUrl }, { frameId: 0, documentId: descriptionSender.documentId, result: descriptionUrl }] } },
    { injectionError: new Error("Tab replaced") }
  ];
  for (const item of cases) {
    const h = descriptionHarness({ ...(item.live ? { tabStates: { 9: { url: item.live, documentId: descriptionSender.documentId } } } : {}),
      ...(item.injectionResults ? { injectionResults: item.injectionResults } : {}), injectionError: item.injectionError });
    await settle();
    const response = await requestDescription(h, { job: item.job || descriptionJob });
    assert.equal(response.error?.code, "TRACKER_IDENTITY_MISMATCH", JSON.stringify(item));
    assert.equal(h.calls.some(call => call.action === "description-fetch"), false);
    assertDescriptionReadOnly(h);
  }
});

test("public description rejects sign-in, other-job, foreign and malformed redirects", async () => {
  const urls = [
    "https://www.linkedin.com/authwall?sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2F123%2F",
    "https://www.linkedin.com/login", "https://www.linkedin.com/jobs/view/456/",
    "https://www.linkedin.com/jobs/view/senior-engineer-456/", "https://www.linkedin.com/jobs/view/123/apply/",
    "https://www.linkedin.com/jobs/view/fake%2Fpath-123/", "https://www.linkedin.com/jobs/view/fake%5Cpath-123/",
    "https://www.linkedin.com/jobs/view/123/?currentJobId=456", "https://careers.example.com/jobs/view/123/",
    "https://www.linkedin.com.evil.test/jobs/view/123/", "http://www.linkedin.com/jobs/view/123/",
    "https://user:secret@www.linkedin.com/jobs/view/123/", "https://www.linkedin.com:444/jobs/view/123/", "not a url"
  ];
  for (const url of urls) {
    const h = descriptionHarness({ descriptionFetch: async () => publicHtmlResponse({ url }) }); await settle();
    const response = await requestDescription(h);
    assert.equal(response.error?.code, "TRACKER_DESCRIPTION_UNAVAILABLE", url);
    assert.equal(response.result, undefined);
    assert.match(response.error.message, /redirected/iu);
    assertDescriptionReadOnly(h);
  }
});

test("public description reports HTTP, non-HTML, authwall and request failures without exposing a response body", async () => {
  const cases = [
    { options: { status: 429 }, reason: /HTTP 429/u }, { options: { status: 404 }, reason: /HTTP 404/u },
    { options: { status: 204 }, reason: /HTTP 204/u },
    { options: { contentType: "application/json" }, reason: /did not return HTML/u },
    { options: { contentType: "text/plain" }, reason: /did not return HTML/u },
    { options: { html: "<html><title>Sign In | LinkedIn</title><body>Login required</body></html>" }, reason: /authwall/u },
    { options: { html: '<html><title>LinkedIn</title><body class="authwall-v2">Join to see this job</body></html>' }, reason: /authwall/u },
    { fail: true, reason: /request failed/u }, { bodyFail: true, reason: /could not be read/u }
  ];
  for (const item of cases) {
    const h = descriptionHarness({ descriptionFetch: async () => {
      if (item.fail) throw new Error("private network diagnostics must not escape");
      const response = publicHtmlResponse(item.options);
      if (item.bodyFail) response.text = async () => { throw new Error("private response diagnostics"); };
      return response;
    } }); await settle();
    const response = await requestDescription(h);
    assert.equal(response.error?.code, "TRACKER_DESCRIPTION_UNAVAILABLE", JSON.stringify(item));
    assert.match(response.error.message, item.reason);
    assert.equal(response.result, undefined);
    assertDescriptionReadOnly(h);
  }
});

test("public description bounds both declared length and actual UTF-8 stream bytes", async () => {
  for (const options of [
    { contentLength: "750001" }, { html: "a".repeat(750001) }, { html: "é".repeat(400000) },
    { chunks: [new Uint8Array(400000), new Uint8Array(350001)] }
  ]) {
    const h = descriptionHarness({ descriptionFetch: async () => publicHtmlResponse(options) }); await settle();
    const response = await requestDescription(h);
    assert.equal(response.error?.code, "TRACKER_DESCRIPTION_UNAVAILABLE");
    assert.match(response.error.message, /750,000-byte limit/u);
    assert.equal(h.calls.find(call => call.action === "description-fetch").options.signal.aborted, true);
    assert.equal(response.result, undefined);
    assertDescriptionReadOnly(h);
  }
});

test("public description aborts after 20 seconds even when the fetch ignores cancellation", async () => {
  let finish;
  const h = descriptionHarness({ descriptionFetch: () => new Promise(resolve => { finish = resolve; }) }); await settle();
  const pending = requestDescription(h);
  await settle();
  const timer = [...h.timers.values()].find(item => item.delay === 20_000);
  assert.ok(timer);
  timer.callback();
  const response = await pending;
  assert.equal(response.error?.code, "TRACKER_DESCRIPTION_UNAVAILABLE");
  assert.match(response.error.message, /within 20 seconds/u);
  assert.equal(h.calls.find(call => call.action === "description-fetch").options.signal.aborted, true);
  finish(publicHtmlResponse()); await settle();
  assert.equal([...h.timers.values()].some(item => item.delay === 20_000), false);
  assertDescriptionReadOnly(h);
});

test("public description also times out while an HTML body is stalled", async () => {
  let finish;
  const response = publicHtmlResponse();
  response.body = { getReader() { return { read: () => new Promise(resolve => { finish = resolve; }), releaseLock() {} }; } };
  const h = descriptionHarness({ descriptionFetch: async () => response }); await settle();
  const pending = requestDescription(h);
  await settle();
  [...h.timers.values()].find(item => item.delay === 20_000).callback();
  const result = await pending;
  assert.equal(result.error?.code, "TRACKER_DESCRIPTION_UNAVAILABLE");
  assert.match(result.error.message, /within 20 seconds/u);
  finish({ done: true }); await settle();
  assertDescriptionReadOnly(h);
});

test("public description requires an active matching run before fetching and does not claim the job", async () => {
  const h = descriptionHarness(); await settle();
  const stopped = await requestDescription(h, { runId: "stopped-run" });
  assert.equal(stopped.error?.code, "TRACKER_RUN_STOPPED");
  assert.equal(h.calls.some(call => call.action === "description-fetch"), false);
  await h.context.toggleJobCollection({ id: 9, url: descriptionUrl });
  const state = clone(collection(h));
  const result = await requestDescription(h, { runId: state.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(collection(h), state, "loading public HTML never marks a job visited or saved");
  assertDescriptionReadOnly(h);
});

test("a stopped run or a replaced document, selected job or search discards late public HTML", async () => {
  for (const change of ["stop", "document", "job", "search", "closed-tab"]) {
    let finish;
    const h = descriptionHarness({ descriptionFetch: () => new Promise(resolve => { finish = resolve; }) }); await settle();
    await h.context.toggleJobCollection({ id: 9, url: descriptionUrl });
    const runId = collection(h).id;
    const pending = requestDescription(h, { runId });
    await settle(); assert.equal(typeof finish, "function");
    if (change === "stop") await h.context.stopActiveCollection(9);
    else if (change === "document") h.tabStates[9].documentId = "replacement-document";
    else if (change === "job") h.tabStates[9].url = descriptionUrl.replace("currentJobId=123", "currentJobId=456");
    else if (change === "search") h.tabStates[9].url = descriptionUrl.replace("keywords=backend", "keywords=python");
    else { h.removeTab(9); await settle(); }
    finish(publicHtmlResponse());
    const result = await pending;
    assert.equal(result.ok, false, change);
    assert.ok(["TRACKER_RUN_STOPPED", "TRACKER_IDENTITY_MISMATCH"].includes(result.error.code), JSON.stringify(result));
    assert.equal(result.result, undefined, change);
    assertDescriptionReadOnly(h);
  }
});
