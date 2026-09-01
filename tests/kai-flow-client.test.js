const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const SECURITY = fs.readFileSync(path.join(ROOT, "src/tracker-security.js"), "utf8");
const SOURCE = fs.readFileSync(path.join(ROOT, "src/kai-flow-client.js"), "utf8");
const BACKGROUND = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const KEY = "kaiFlowRemoteTracker";
const ID = "lomiekljcjnlhfpklnjmmhomknfigofn";
const ORIGIN = "https://kai.example.test";
const LINK = `${ORIGIN}/#tracker-pair=kfp_01234567890123456789012345678901`;
const JOB = { company: "Example Company", title: "Software Engineer", description: "Build thoughtful software.", applyUrl: "https://example.test/jobs/123" };
const NOW = 1800000000000;
const clone = (value) => structuredClone(value);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const json = (result, status = 200, other = {}) => ({ ok: status >= 200 && status < 300, status, url: "", redirected: false, text: async () => JSON.stringify(status >= 200 && status < 300 ? { ok: true, result } : { ok: false, error: result }), ...other });

function harness(options = {}) {
  const stored = options.stored || {};
  const calls = [], storageEvents = [], permissionChecks = [];
  let time = options.time ?? NOW;
  const storage = {
    async setAccessLevel(value) { storageEvents.push({ access: clone(value) }); if (options.untrustedStorage) throw new Error("No access"); },
    async get(key) { storageEvents.push({ read: key }); return clone({ [key]: stored[key] }); },
    async set(value) { storageEvents.push({ write: clone(value) }); if (options.failStorage?.()) throw new Error("Disk failed"); Object.assign(stored, clone(value)); }
  };
  const context = vm.createContext({ URL, TextEncoder, Uint8Array, AbortController, setTimeout, clearTimeout });
  vm.runInContext(SECURITY, context);
  vm.runInContext(SOURCE, context);
  const client = context.KaiFlowTrackerClient.create({
    storage, permissions: { async contains(value) { permissionChecks.push(clone(value)); return options.permission !== false; } }, cryptoImpl: webcrypto, now: () => time, timeoutMs: options.timeoutMs ?? 50,
    async fetchImpl(url, init) {
      const call = { url, init, body: JSON.parse(init.body), action: url.split("/").at(-1) };
      calls.push(call);
      if (options.onFetch) { const response = await options.onFetch(call, { stored, calls, time }); if (response !== undefined) return response; }
      if (call.action === "pair") return json({ token: "kft_" + "T".repeat(43), deviceId: "device-1", serverId: "server-1", expiresAt: time + 90 * 86400000 });
      if (call.action === "options") return json({ profiles: ["profile-1", "profile-2"], profileLabels: { "profile-1": "Alex", "profile-2": "Jamie" } });
      if (call.action === "duplicate") return json({ duplicate: null });
      return json({ status: "inserted", job: { rowNumber: 75, company: call.body.company, jobTitle: call.body.jobTitle, status: "added", profile: call.body.profile } });
    }
  });
  return { client, stored, calls, storageEvents, permissionChecks, security: context.KaiFlowTrackerSecurity, advance(ms) { time += ms; } };
}

test("manifest preserves pinned identity and requests remote permission only optionally", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json")));
  const identity = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + parseInt(hex, 16)));
  assert.equal(identity, ID);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.host_permissions.some((value) => /localhost|127\.|\*:\/\//.test(value)), false);
  assert.ok(manifest.permissions.includes("alarms"));
  assert.equal(manifest.minimum_chrome_version, "120");
  assert.match(manifest.content_security_policy.extension_pages, /connect-src https:/);
  assert.doesNotMatch(SOURCE + BACKGROUND, /localhost|127\.0\.0\.1|WebSocket|4177/);
});

test("pairing accepts only complete remote HTTPS links without URL credentials", () => {
  const h = harness();
  assert.deepEqual(clone(h.security.parsePairingLink(LINK)), { origin: ORIGIN, code: LINK.split("=")[1], permission: `${ORIGIN}/*` });
  for (const link of [LINK.replace("https:", "http:"), LINK.replace("kai.example.test", "127.0.0.1"), LINK.replace("kai.example.test", "localhost"), LINK.replace("kai.example.test", "[::1]"), LINK.replace("kai.example.test", "user:pass@kai.example.test"), LINK.replace("/#", "/other#"), LINK + "&token=x", LINK.replace("/#", "/?x=1#")]) assert.throws(() => h.security.parsePairingLink(link));
});

test("pairing uses numeric expiry and never returns the stored credential to popup", async () => {
  const h = harness();
  const status = await h.client.pair(LINK, "A".repeat(200));
  assert.equal(status.paired, true);
  assert.equal(status.expiresAt, NOW + 90 * 86400000);
  assert.equal(h.calls[0].body.deviceName.length, 80);
  assert.equal(h.calls[0].body.code, LINK.split("=")[1]);
  assert.equal(h.calls[0].init.headers.Authorization, undefined);
  assert.equal(h.stored[KEY].config.token, "kft_" + "T".repeat(43));
  assert.doesNotMatch(JSON.stringify(status), /kft_|tracker-pair|token/);
  assert.deepEqual(h.storageEvents[0], { access: { accessLevel: "TRUSTED_CONTEXTS" } });
});

test("all authenticated calls stay on their paired origin and omit browser credentials and redirects", async () => {
  const h = harness();
  await h.client.pair(LINK);
  await h.client.getOptions({ refresh: true });
  await h.client.lookupDuplicate("Example");
  await h.client.saveJob(JOB);
  for (const call of h.calls) {
    assert.match(call.url, /^https:\/\/kai\.example\.test\/api\/tracker\/(pair|options|duplicate|save)$/);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.referrerPolicy, "no-referrer");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.headers["ngrok-skip-browser-warning"], "true");
    if (call.action !== "pair") assert.match(call.init.headers.Authorization, /^Bearer kft_/);
  }
  assert.ok(h.permissionChecks.every((value) => value.origins.length === 1 && value.origins[0] === `${ORIGIN}/*`));
});

test("missing permission and inaccessible trusted storage prevent every network request", async () => {
  for (const options of [{ permission: false }, { untrustedStorage: true }]) {
    const h = harness(options);
    await assert.rejects(h.client.pair(LINK));
    assert.equal(h.calls.length, 0);
  }
});

test("redirected responses are not treated as success or followed", async () => {
  const h = harness({ onFetch(call) { if (call.action === "options") return json({}, 200, { redirected: true, url: "https://other.example.test" }); } });
  await h.client.pair(LINK);
  await assert.rejects(h.client.getOptions(), { code: "TRACKER_REDIRECT_BLOCKED" });
  assert.equal(h.calls.length, 2);
});

test("profile options refresh live and optional blank profile stays blank", async () => {
  const h = harness();
  await h.client.pair(LINK);
  await h.client.getOptions();
  await h.client.getOptions({ refresh: true });
  assert.equal(h.calls.filter((call) => call.action === "options").length, 2);
  assert.deepEqual(clone((await h.client.getStatus()).profileOptions.profiles), ["profile-1", "profile-2"]);
  await h.client.saveJob(JOB);
  const saved = h.calls.find((call) => call.action === "save");
  assert.equal(saved.body.profile, "");
  assert.equal(saved.body.jobDescription, JOB.description);
  assert.equal(saved.body.status, undefined);
});

test("successful saves reuse durable request ID without a second network save", async () => {
  const h = harness();
  await h.client.pair(LINK);
  const result = await h.client.saveJob(JOB, { profile: "profile-1" });
  assert.equal(result.status, "inserted");
  assert.equal(result.replayed, false);
  assert.equal((await h.client.saveJob(JOB, { profile: "profile-1" })).replayed, true);
  const restarted = harness({ stored: h.stored });
  assert.equal((await restarted.client.saveJob(JOB, { profile: "profile-1" })).replayed, true);
  assert.equal(restarted.calls.length, 0);
  assert.equal(h.calls.filter((call) => call.action === "save").length, 1);
});

test("outage queues the original request and alarm retries after 30 seconds", async () => {
  let offline = true;
  const h = harness({ onFetch(call, { stored }) {
    if (call.action !== "save") return;
    assert.equal(stored[KEY].entries[0].requestId, call.body.requestId, "ID persisted before fetch");
    assert.equal(stored[KEY].entries[0].state, "sending");
    if (offline) throw new TypeError("Proxy unavailable");
  } });
  await h.client.pair(LINK);
  const queued = await h.client.saveJob(JOB);
  assert.equal(queued.status, "queued");
  assert.equal(queued.state, "retry");
  await h.client.flushQueue();
  assert.equal(h.calls.filter((call) => call.action === "save").length, 1);
  offline = false; h.advance(30000);
  await h.client.flushQueue();
  const saves = h.calls.filter((call) => call.action === "save");
  assert.equal(saves.length, 2);
  assert.equal(saves[0].body.requestId, saves[1].body.requestId);
  assert.equal((await h.client.getStatus()).entries[0].state, "saved");
});

test("network timeout remains queued and restart retries the same ID", async () => {
  const h = harness({ timeoutMs: 5, onFetch(call) {
    if (call.action === "save") return new Promise((resolve, reject) => call.init.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  await h.client.pair(LINK);
  const queued = await h.client.saveJob(JOB);
  assert.equal(queued.status, "queued");
  const restarted = harness({ stored: h.stored, time: NOW + 30000 });
  await restarted.client.flushQueue();
  assert.equal(restarted.calls[0].body.requestId, queued.requestId);
  assert.equal((await restarted.client.getStatus()).entries[0].state, "saved");
});

test("worker restart while a save was sending retains uncertainty and same ID", async () => {
  const h = harness({ onFetch(call) { if (call.action === "save") throw new Error("offline"); } });
  await h.client.pair(LINK);
  await h.client.saveJob(JOB);
  h.stored[KEY].entries[0].state = "sending";
  const restarted = harness({ stored: h.stored });
  await restarted.client.flushQueue();
  assert.equal(restarted.calls[0].body.requestId, h.calls.at(-1).body.requestId);
});

test("editing an uncertain job cannot create another ID for the same company", async () => {
  const h = harness({ onFetch(call) { if (call.action === "save") throw new Error("offline"); } });
  await h.client.pair(LINK);
  const first = await h.client.saveJob(JOB);
  const second = await h.client.saveJob({ ...JOB, title: "Edited title" }, { profile: "profile-2" });
  assert.equal(second.requestId, first.requestId);
  assert.equal(h.stored[KEY].entries.length, 1);
  assert.equal(h.calls.filter((call) => call.action === "save").length, 1);
});

test("cancel stops retry but preserves a sent request tombstone across restarts", async () => {
  const h = harness({ onFetch(call) { if (call.action === "save") throw new Error("offline"); } });
  await h.client.pair(LINK);
  const first = await h.client.saveJob(JOB);
  await h.client.cancel(first.requestId);
  h.advance(30000); await h.client.flushQueue();
  assert.equal(h.calls.filter((call) => call.action === "save").length, 1);
  const restarted = harness({ stored: h.stored });
  const same = await restarted.client.saveJob(JOB);
  assert.equal(same.status, "canceled");
  assert.equal(same.mayHaveSaved, true);
  assert.equal(restarted.calls.length, 0);
});

test("canceling in-flight save never claims a confirmed inserted job was canceled", async () => {
  let release;
  const h = harness({ onFetch(call) { if (call.action === "save") return new Promise((resolve) => { release = () => resolve(json({ status: "inserted", job: { company: JOB.company } })); }); } });
  await h.client.pair(LINK);
  const saving = h.client.saveJob(JOB);
  for (let n = 0; n < 50 && !release; n++) await flush();
  const status = await h.client.getStatus();
  await h.client.cancel(status.entries[0].requestId);
  release();
  assert.equal((await saving).status, "inserted");
  assert.equal((await h.client.getStatus()).entries[0].state, "saved");
});

test("expired/revoked pairing pauses automatic requests without throwing away queued jobs", async () => {
  const h = harness({ onFetch(call) { if (call.action === "save") return json({ code: "TRACKER_PAIRING_REQUIRED", message: "Reconnect tracker." }, 401); } });
  await h.client.pair(LINK);
  const first = await h.client.saveJob(JOB);
  assert.equal(first.state, "auth-paused");
  h.advance(30000); await h.client.flushQueue();
  assert.equal(h.calls.filter((call) => call.action === "save").length, 1);
  assert.equal((await h.client.getStatus()).connection, "revoked");
  await assert.rejects(h.client.getOptions(), { code: "TRACKER_PAIRING_REQUIRED" });
  const expired = harness(); await expired.client.pair(LINK); expired.advance(91 * 86400000);
  await assert.rejects(expired.client.saveJob(JOB), { code: "TRACKER_TOKEN_EXPIRED" });
  assert.equal(expired.calls.length, 1);
});

test("pairing to a different device or server never transfers an existing queue", async () => {
  let device = "device-1";
  let offline = true;
  const h = harness({ onFetch(call, { time }) {
    if (call.action === "pair") return json({ token: "kft_" + "A".repeat(43), deviceId: device, serverId: call.url.startsWith(ORIGIN) ? "server-1" : "server-2", expiresAt: time + 86400000 });
    if (call.action === "save" && offline) throw new Error("offline");
  } });
  await h.client.pair(LINK);
  await h.client.saveJob(JOB);
  device = "device-2";
  await h.client.pair(LINK);
  h.advance(30000); offline = false; await h.client.flushQueue();
  assert.equal((await h.client.getStatus()).entries[0].connectionMatches, false);
  await h.client.pair(LINK.replace("kai.example.test", "other.example.test"));
  await h.client.flushQueue();
  assert.equal(h.calls.filter((call) => call.action === "save").length, 1);
});

test("explicit server uncertain result needs owner review and is never auto-reappended", async () => {
  const h = harness({ onFetch(call) { if (call.action === "save") return json({ code: "TRACKER_SAVE_UNCERTAIN", message: "Owner must reconcile." }, 409); } });
  await h.client.pair(LINK);
  const result = await h.client.saveJob(JOB);
  assert.equal(result.state, "review");
  h.advance(30000); await h.client.flushQueue();
  assert.equal(h.calls.filter((call) => call.action === "save").length, 1);
});

test("definitive rejection never automatically retries; an explicit new Save may create a fresh ID", async () => {
  const duplicate = { company: JOB.company, jobTitle: "Existing job", status: "applied" };
  const h = harness({ onFetch(call) { if (call.action === "save") return json({ code: "DUPLICATE_COMPANY", message: "Already exists.", details: { duplicate, saveRejected: true } }, 409); } });
  await h.client.pair(LINK);
  await assert.rejects(h.client.saveJob(JOB), (e) => e.code === "DUPLICATE_COMPANY" && e.details.duplicate.company === JOB.company);
  h.advance(30000); await h.client.flushQueue();
  assert.equal(h.calls.filter((call) => call.action === "save").length, 1);
  await assert.rejects(h.client.saveJob(JOB), { code: "DUPLICATE_COMPANY" });
  const saves = h.calls.filter((call) => call.action === "save");
  assert.equal(saves.length, 2);
  assert.notEqual(saves[0].body.requestId, saves[1].body.requestId);
  assert.equal(h.stored[KEY].entries.length, 2);
  assert.equal(h.stored[KEY].entries[0].mayHaveSaved, false);
});

test("a never-sent canceled job can be explicitly queued again without losing the cancellation record", async () => {
  const h = harness({ onFetch(call) { if (call.action === "save") throw new Error("offline"); } });
  await h.client.pair(LINK); await h.client.saveJob(JOB);
  h.stored[KEY].entries[0].state = "queued";
  h.stored[KEY].entries[0].mayHaveSaved = false;
  const restarted = harness({ stored: h.stored });
  const id = h.stored[KEY].entries[0].requestId;
  await restarted.client.cancel(id);
  await restarted.client.flushQueue();
  assert.equal(restarted.calls.length, 0);
  await restarted.client.saveJob(JOB);
  assert.notEqual(restarted.calls[0].body.requestId, id);
  assert.equal(h.stored[KEY].entries.length, 2);
  assert.equal(h.stored[KEY].entries[0].state, "canceled");
});

test("retry age expires after 7 days but sent requests remain for owner reconciliation", async () => {
  const h = harness({ onFetch(call) { if (call.action === "save") throw new Error("offline"); } });
  await h.client.pair(LINK);
  await h.client.saveJob(JOB);
  h.advance(8 * 86400000); await h.client.flushQueue();
  assert.equal((await h.client.getStatus()).entries[0].state, "review");
  assert.equal(h.calls.filter((call) => call.action === "save").length, 1);
  await h.client.saveJob({ ...JOB, company: "Different company" });
  assert.equal(h.stored[KEY].entries.length, 2);
});

test("durable queue is bounded and never evicts unresolved records", async () => {
  const h = harness({ onFetch(call) { if (call.action === "save") throw new Error("offline"); } });
  await h.client.pair(LINK); await h.client.saveJob(JOB);
  const template = h.stored[KEY].entries[0];
  h.stored[KEY].entries = Array.from({ length: 256 }, (_, index) => ({ ...clone(template), requestId: webcrypto.randomUUID(), fingerprint: createHash("sha256").update(String(index)).digest("hex"), job: { ...template.job, company: `Company ${index}` } }));
  const restarted = harness({ stored: h.stored });
  await assert.rejects(restarted.client.saveJob(JOB), { code: "TRACKER_QUEUE_FULL" });
  assert.equal(restarted.calls.length, 0);
  assert.equal(h.stored[KEY].entries.length, 256);
});

test("storage failure prevents transmission and validation requires company/title/description", async () => {
  let fail = false;
  const h = harness({ failStorage: () => fail });
  await h.client.pair(LINK); fail = true;
  await assert.rejects(h.client.saveJob(JOB), { code: "KAI_FLOW_STORAGE_ERROR" });
  assert.equal(h.calls.length, 1);
  for (const missing of ["company", "title", "description"]) await assert.rejects(h.client.saveJob({ ...JOB, [missing]: "" }), { code: "MISSING_JOB_FIELDS" });
  await assert.rejects(h.client.saveJob({ ...JOB, applyUrl: "javascript:alert(1)" }), { code: "INVALID_APPLY_URL" });
});

test("high-volume successful saves make room by evicting only old safe history", async () => {
  const h = harness(); await h.client.pair(LINK); await h.client.saveJob(JOB);
  const template = h.stored[KEY].entries[0];
  h.stored[KEY].entries = Array.from({ length: 256 }, (_, index) => ({ ...clone(template), requestId: webcrypto.randomUUID(), fingerprint: createHash("sha256").update(String(index)).digest("hex"), job: { ...template.job, company: `Company ${index}` }, updatedAt: NOW + index }));
  const removedId = h.stored[KEY].entries[0].requestId;
  const restarted = harness({ stored: h.stored, time: NOW + 1000 });
  assert.equal((await restarted.client.saveJob(JOB)).status, "inserted");
  assert.equal(h.stored[KEY].entries.length, 256);
  assert.equal(h.stored[KEY].entries.some((entry) => entry.requestId === removedId), false);
});

test("worker privileges are limited to its exact own popup; alarms and shortcut stay supported", async () => {
  const handlers = {}, calls = [], alarms = [];
  const client = { init: async () => {}, flushQueue: async () => calls.push(["flush"]), pair: async (...args) => calls.push(["pair", ...args]), getStatus: async () => ({ paired: false }), cancel: async (...args) => calls.push(["cancel", ...args]), getOptions: async () => ({ profiles: [] }), lookupDuplicate: async () => ({ duplicate: null }), saveJob: async (...args) => { calls.push(["save", ...args]); return { status: "queued" }; } };
  const event = (name) => ({ addListener(fn) { handlers[name] = fn; } });
  const chrome = {
    runtime: { id: ID, getURL: (file) => `chrome-extension://${ID}/${file}`, onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup") },
    alarms: { onAlarm: event("alarm"), create: async (...args) => alarms.push(args) },
    commands: { onCommand: event("command") },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    tabs: { query: async () => [{ id: 1, url: "https://www.linkedin.com/jobs/view/1" }], sendMessage: async () => ({ ok: true, data: JOB }) },
    storage: { local: { get: async () => ({ kaiFlowSelectedProfile: "" }) } }, scripting: { executeScript: async () => {} }
  };
  vm.runInNewContext(BACKGROUND, { importScripts() {}, KaiFlowTrackerClient: { create: () => client }, chrome, URL, setTimeout() {} });
  await flush();
  for (const sender of [{ id: ID, url: "https://www.linkedin.com/jobs/view/1" }, { id: "other", url: `chrome-extension://${ID}/popup.html` }, { id: ID, url: `chrome-extension://${ID}/popup.html?evil=1` }]) {
    for (const type of ["KAI_TRACKER_SAVE", "KAI_TRACKER_PAIR", "KAI_TRACKER_CANCEL", "KAI_TRACKER_STATUS"]) {
      let result;
      assert.equal(handlers.message({ type, link: LINK }, sender, (value) => { result = value; }), false);
      assert.equal(result.error.code, "TRACKER_FORBIDDEN");
    }
  }
  let answer;
  assert.equal(handlers.message({ type: "KAI_TRACKER_PAIR", link: LINK }, { id: ID, url: `chrome-extension://${ID}/popup.html` }, (value) => { answer = value; }), true);
  await flush(); assert.equal(answer.ok, true);
  handlers.command("scrape-and-save-job"); await flush();
  assert.ok(calls.some((call) => call[0] === "save" && call[2].profile === ""));
  assert.equal(alarms[0][1].periodInMinutes, 0.5);
  const before = calls.filter((call) => call[0] === "flush").length;
  handlers.alarm({ name: "kai-flow-remote-queue" }); await flush();
  assert.equal(calls.filter((call) => call[0] === "flush").length, before + 1);
});
