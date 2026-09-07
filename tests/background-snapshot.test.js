const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const BACKGROUND = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const BANNED = fs.readFileSync(path.join(ROOT, "src/banned-companies.js"), "utf8");
const SNAPSHOT_KEY = "kaiFlowCompanySnapshotV1";

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function harness({ stored = {}, snapshots = [{ companies: ["Acme"], revision: "r1" }], banned = ["Blocked Co"] } = {}) {
  const calls = [];
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
      return { status: "inserted", job: { company: job.company, rowNumber: 10 } };
    }
  };
  const chrome = {
    storage: { local },
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
      async query() { return []; },
      async sendMessage() { return { ok: true }; }
    },
    commands: { onCommand: { addListener() {} } },
    scripting: { async executeScript() {} }
  };
  const context = vm.createContext({
    chrome,
    URL,
    console,
    setTimeout() { return 1; },
    importScripts() {},
    GoogleSheetsTrackerClient: { create() { return client; } }
  });
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

  async function sendRaw(message, kind = "linkedin") {
    const sender = kind === "popup"
      ? { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") }
      : kind === "linkedin" ? { id: chrome.runtime.id, url: "https://www.linkedin.com/jobs/search-results/" }
        : { id: chrome.runtime.id, url: "https://example.test/" };
    let handled;
    const response = await new Promise((resolve) => {
      handled = messageListeners[0](message, sender, resolve);
      if (handled === undefined) resolve(undefined);
    });
    return { handled, response };
  }

  return { calls, send, sendRaw, stored };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

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
  const h = harness({ snapshots: [{ companies: ["Acme"], revision: "r1" }, never] });
  await settle();

  const saved = await h.send({ type: "KAI_TRACKER_SAVE", job: { company: "New Company" } }, "popup");
  assert.equal(saved.ok, true);
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
