const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const BACKGROUND = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const BANNED = fs.readFileSync(path.join(ROOT, "src/banned-companies.js"), "utf8");
const SNAPSHOT_KEY = "kaiFlowCompanySnapshotV1";
const duties = "Design and build JavaScript services and maintain automated tests.";
const engineeringJob = { jobId: "123", jobIdSource: "details", sourceUrl: "https://www.linkedin.com/jobs/search-results/",
  company: "New Company", title: "Senior JavaScript Engineer", description: duties, workplaceType: "remote", isEasyApply: false };
const successfulResearch = async (_url, options) => ({ ok: true, json: async () => options.method === "POST" ? { state: "queued" }
  : { state: "completed", completedAt: new Date().toISOString(), result: { decision: "save", company: engineeringJob.company,
    title: engineeringJob.title, role: { eligible: true, category: "software-development", evidence: duties } } } });

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function harness({ stored = {}, sessionStored = {}, snapshots = [{ companies: ["Acme"], revision: "r1" }], banned = ["Blocked Co"], researchFetch = null, saveError = null, autoDiscardable = true } = {}) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const messageListeners = [];
  let snapshotCursor = 0;
  const local = {
    async get(key) { return { [key]: clone(stored[key]) }; },
    async set(value) { Object.assign(stored, clone(value)); }
  };
  const client = {
    async init() {},
    async getStatus() { calls.push({ action: "status" }); return { configured: true }; },
    async configure() { calls.push({ action: "configure" }); return { configured: true }; },
    async clearConfiguration() { calls.push({ action: "clear" }); return { configured: false }; },
    async getOptions() { return { profiles: [] }; },
    async lookupDuplicate() { calls.push({ action: "duplicate" }); return { duplicate: null }; },
    async getCompanies(options) {
      calls.push({ action: "companies", options: clone(options) });
      const response = snapshots[Math.min(snapshotCursor++, snapshots.length - 1)];
      return typeof response === "function" ? response(options) : clone(response);
    },
    async saveJob(job) {
      calls.push({ action: "save", company: job.company });
      if (saveError) throw saveError;
      return { status: "inserted", job: { company: job.company, rowNumber: 10 } };
    }
  };
  const chrome = {
    alarms: { onAlarm: { addListener() {} }, async create() {}, async clear() {} },
    storage: { local, session: {
      async get(key) { return { [key]: clone(sessionStored[key]) }; },
      async set(values) { Object.assign(sessionStored, clone(values)); }
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
      async get(id) { return { id, url: "https://www.linkedin.com/jobs/search-results/", autoDiscardable }; },
      async update(id, properties) { calls.push({ action: "tab-update", tabId: id, properties: clone(properties) }); return { id, ...properties }; },
      async query() { return []; },
      async sendMessage(tabId, message) { calls.push({ action: "tab-message", tabId, message: clone(message) }); return { ok: true }; }
    },
    commands: { onCommand: { addListener() {} } },
    scripting: { async executeScript() {} }
  };
  const context = vm.createContext({
    chrome,
    URL,
    console,
    crypto: require("node:crypto").webcrypto,
    AbortSignal,
    fetch: researchFetch || (async () => { throw new Error("Unexpected research request"); }),
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    importScripts() {},
    KaiLocalStoreClient: { create() { return client; } }
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/capture-policy.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/research-client.js"), "utf8"), context);
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
    let handled;
    const response = await new Promise((resolve) => {
      handled = messageListeners[0](message, sender, resolve);
      if (handled === undefined) resolve(undefined);
    });
    return { handled, response };
  }

  return { calls, send, sendRaw, stored, sessionStored, context, chrome, timers };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("closed or unverified application controls cannot reach a Sheet save", async () => {
  const h = harness(); await settle();
  for (const flags of [{ applicationsClosed: true }, { applicationsAvailable: false }]) {
    const response = await h.send({ type: "KAI_TRACKER_SAVE", job: { company: "New Company", workplaceType: "remote", isEasyApply: false, ...flags } }, "popup");
    assert.equal(response.result.status, "skipped");
  }
  assert.equal(h.calls.some((call) => call.action === "save"), false);
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
        const response = await h.send({ type, job: { jobId: String(++jobId), company: "New Company", title: "Engineer", workplaceType, isEasyApply,
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
  const state = h.sessionStored.jobTrackerCollectionV1;
  assert.ok(state.id); assert.equal(state.tabId, tab.id);
  assert.equal(h.calls.find((entry) => entry.action === "tab-message").message.type, "KAI_TRACKER_RUN_START");
  const job = { jobId: "123", jobIdSource: "details", sourceUrl: tab.url, company: "New Company", title: "Engineer", description: "Description", workplaceType: "remote", isEasyApply: false };
  const outsider = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId: state.id }, "linkedin", { tab: { id: 7 } });
  assert.equal(outsider.response.error.code, "TRACKER_RUN_STOPPED");
  const otherState = await h.sendRaw({ type: "KAI_TRACKER_RUN_STATE" }, "linkedin", { tab: { id: 7 } });
  assert.equal(otherState.response.result.state, null);
  await h.context.toggleJobCollection(tab); assert.equal(h.sessionStored.jobTrackerCollectionV1, null);
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
  await h.context.toggleJobCollection(tab); const runId = h.sessionStored.jobTrackerCollectionV1.id;
  const job = engineeringJob;
  const results = await Promise.all([1, 2].map(() => h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId }, "linkedin", { tab })));
  assert.deepEqual(results.map((entry) => entry.response.result.status).sort(), ["researching", "skipped"]);
  assert.equal(requests.length, 1); assert.equal(h.calls.filter((entry) => entry.action === "save").length, 0);
  const resumed = harness({ sessionStored: h.sessionStored }); await settle();
  const replay = await resumed.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId }, "linkedin", { tab });
  assert.equal(replay.response.result.status, "skipped"); assert.equal(resumed.calls.some((entry) => entry.action === "save"), false);
  const changed = await resumed.sendRaw({ type: "KAI_TRACKER_RUN_STATE" }, "linkedin", { tab, url: tab.url + "?keywords=different" });
  assert.equal(changed.response.result.state, null); assert.equal(resumed.sessionStored.jobTrackerCollectionV1, null);
});
test("an uncertain automatic write remains claimed after failure and cannot be replayed on worker recovery", async () => {
  const sessionStored = {}, tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  const h = harness({ sessionStored, researchFetch: successfulResearch, saveError: Object.assign(new Error("Unconfirmed write"), { code: "TRACKER_SAVE_UNCONFIRMED" }) }); await settle();
  await h.context.toggleJobCollection(tab); const runId = sessionStored.jobTrackerCollectionV1.id;
  const job = engineeringJob;
  const queued = await h.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId }, "linkedin", { tab });
  assert.equal(queued.response.result.status, "researching");
  await vm.runInContext("researchClient.poll()", h.context);
  assert.equal(h.stored.jobTrackerResearchV1[0].state, "save-unconfirmed"); assert.deepEqual(sessionStored.jobTrackerCollectionV1.visited, ["123"]);
  assert.equal(h.calls.filter((entry) => entry.action === "save").length, 1);
  const recovered = harness({ sessionStored, stored: h.stored }); await settle();
  const again = await recovered.sendRaw({ type: "KAI_TRACKER_CAPTURE", job, runId }, "linkedin", { tab });
  assert.equal(again.response.result.status, "skipped"); assert.equal(recovered.calls.some((entry) => entry.action === "save"), false);
});

test("background waits are bound to the owner and cancel immediately when stopped from another browser tab", async () => {
  const h = harness(); await settle();
  const tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  await h.context.toggleJobCollection(tab);
  const runId = h.sessionStored.jobTrackerCollectionV1.id;
  const outsider = await h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 20_000 }, "linkedin", { tab: { id: 7 } });
  assert.equal(outsider.response.result.stopped, true);
  const invalid = await h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 30_000 }, "linkedin", { tab });
  assert.equal(invalid.response.ok, false);
  const waiting = h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 20_000 }, "linkedin", { tab });
  await settle();
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 20_000));
  await h.context.toggleJobCollection({ id: 7, url: "https://example.test/" });
  assert.equal((await waiting).response.result.stopped, true);
  assert.equal(h.sessionStored.jobTrackerCollectionV1, null);
  assert.equal([...h.timers.values()].some((timer) => timer.delay === 20_000), false);
  assert.deepEqual(h.calls.filter((entry) => entry.action === "tab-update").map((entry) => entry.properties),
    [{ autoDiscardable: false }, { autoDiscardable: true }]);
});

test("worker delay completion rechecks run ownership and preserves an existing no-discard preference", async () => {
  const h = harness({ autoDiscardable: false }); await settle();
  const tab = { id: 42, url: "https://www.linkedin.com/jobs/search-results/" };
  await h.context.toggleJobCollection(tab);
  const runId = h.sessionStored.jobTrackerCollectionV1.id;
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
  const runId = h.sessionStored.jobTrackerCollectionV1.id;
  const oldWait = h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 250 }, "linkedin", { tab, documentId: "old-page" });
  await settle();
  const newWait = h.sendRaw({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds: 200 }, "linkedin", { tab, documentId: "new-page" });
  await settle();
  assert.equal((await oldWait).response.result.stopped, true);
  assert.equal(h.sessionStored.jobTrackerCollectionV1.id, runId);
  const pending = [...h.timers.values()].find((timer) => timer.delay === 200);
  pending.callback();
  assert.equal((await newWait).response.result.stopped, false);
  await h.context.stopActiveCollection();
});
