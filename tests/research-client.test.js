const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto").webcrypto;
const clone = (value) => structuredClone(value);
const duties = "Develop and maintain software services and automated tests.";
const role = { eligible: true, category: "software-development", evidence: duties };
const job = { company: "Mews", title: "Product Builder - Fintech", description: `${duties} This role is fully remote. Apply to hiring@mews.com.`, workplaceType: "remote", isEasyApply: true,
  sourceUrl: "https://www.linkedin.com/jobs/view/123", applyUrl: "https://www.linkedin.com/jobs/view/123", jobId: "123", privateKey: "do-not-send", profile: "do-not-send" };
const result = { decision: "save", company: job.company, title: job.title, role, application: { url: "https://mews.com/careers/jobs/123", company: job.company, title: job.title, applicationsOpen: true, free: true, evidence: "Open application form observed with submit button." } };
const modelCatalog = { models: [{ id: "session-model-alpha", name: "Research Alpha" }, { id: "session-model-beta", name: "Research Beta" }], defaultModel: "session-model-alpha" };
function harness({ stored = {}, saveError = null, failPostOnce = false, networkError = null, postStatus = 202,
  postJsonError = null, failClientKeyWrite = false, failResearchWriteAt = null,
  catalog = modelCatalog, catalogError = null, nativeMessaging, acceptedSettings = {}, reportError = null, afterSaveError = null,
  destination = "https://docs.google.com/spreadsheets/d/aaa/edit#gid=1", coordinator = null, saveImpl = null,
  profiles = ["kevin", "jagjeet", "jose-ibero-2page", "michal-stefanow-2page"] } = {}) {
  const calls = [], saves = [], outcomes = [], remembered = [], alarmCalls = [], reports = [];
  let researchWrites = 0;
  let state = { configured: true, sheetUrl: destination };
  let response = { state: "completed", completedAt: new Date().toISOString(), result };
  let banned = false;
  const storage = { async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, clone(stored[name])])); }, async set(values) {
    if (failClientKeyWrite && Object.hasOwn(values, "jobTrackerResearchClientV1")) throw new Error("Browser client key storage write failed.");
    if (Object.hasOwn(values, "jobTrackerResearchV1") && ++researchWrites === failResearchWriteAt) throw new Error("Research storage write failed.");
    Object.assign(stored, clone(values));
  }, async remove(key) { delete stored[key]; } };
  const alarms = { async create(name, options) { alarmCalls.push({ name, options: clone(options) }); }, async clear(name) { alarmCalls.push({ name, cleared: true }); } };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options: { ...options, signal: undefined } });
    if (networkError) throw networkError;
    if (url.endsWith("/save-claim")) {
      if (!coordinator) return { ok: false, status: 404, json: async () => ({ error: "Save coordination route unavailable." }) };
      return { ok: true, json: async () => coordinator(url, clone(options), clone(response)) };
    }
    if (url.endsWith("/models")) {
      if (catalogError) throw catalogError;
      return { ok: true, json: async () => clone(catalog) };
    }
    if (options.method === "POST") {
      if (failPostOnce) { failPostOnce = false; throw new Error("connection lost"); }
      if (postStatus >= 400) return { ok: false, status: postStatus, json: async () => {
        if (postJsonError) throw postJsonError;
        return { error: "Research service rejected the request." };
      } };
      return { ok: true, json: async () => ({ state: "researching", ...acceptedSettings }) };
    }
    return { ok: true, json: async () => clone(response) };
  };
  const sheetClient = { async getStatus() { return clone(state); }, async getOptions() { return { profiles: clone(profiles) }; }, async saveJob(data, options) { saves.push(clone({ data, options })); if (saveError) throw saveError; return saveImpl ? saveImpl(data, options, stored) : { status: "inserted" }; } };
  const context = vm.createContext({ URL, AbortSignal, Uint8Array, Date, fetch: fetchImpl, crypto, chrome: { storage: { local: storage }, alarms, runtime: { id: "stable-id" } } });
  for (const name of ["capture-policy", "profile-routing", "research-client"]) vm.runInContext(fs.readFileSync(require.resolve(`../src/${name}.js`), "utf8"), context);
  const client = context.JobResearchClient.create({ storage, fetchImpl, cryptoImpl: crypto, alarms, extensionId: "stable-id", sheetClient, nativeMessaging,
    bannedCompanies: { async has() { return banned; } }, onSaved: async (company) => { remembered.push(company); if (afterSaveError) throw afterSaveError; },
    onNotSaved: async (record, details) => { reports.push(clone({ record, details })); if (reportError) throw reportError; },
    onOutcome: async (_record, message) => outcomes.push(message) });
  return { client, stored, calls, saves, outcomes, remembered, alarmCalls, reports, setResponse(value) { response = value; },
    setNetworkError(value) { networkError = value; }, changeSheet() { state.sheetUrl += "different"; }, ban() { banned = true; } };
}

const FILE_DESTINATION = "applicantally-file:00000000-0000-0000-0000-000000000001";
function saveCoordinator() {
  const claims = new Map(), calls = [];
  const service = async (url, options, response) => {
    const body = JSON.parse(options.body), requestId = url.split("/").at(-2), owner = options.headers["X-Job-Tracker-Client"];
    calls.push({ ...body, requestId, owner });
    if (body.action === "settle") {
      if (service.failSettle) throw new Error("The worker stopped before acknowledging settlement.");
      for (const [key, claim] of claims) if (claim.requestId === requestId && claim.owner === owner && claim.destination === body.destination && claim.token === body.token) claims.delete(key);
      return { settled: true };
    }
    if (service.failAcquire) throw new Error("Save coordination is offline.");
    if (service.busy) return { acquired: false, code: "SAVE_COORDINATION_BUSY", message: "Another browser is saving this company." };
    const key = JSON.stringify([body.destination, response.result.company.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US")]);
    const claim = claims.get(key);
    if (claim && (claim.requestId !== requestId || claim.owner !== owner)) return { acquired: false, code: "SAVE_COORDINATION_BUSY", message: "Another browser is saving this company." };
    if (!claim) claims.set(key, { requestId, owner, destination: body.destination, token: crypto.randomUUID() });
    return { acquired: true, token: claims.get(key).token };
  };
  return Object.assign(service, { claims, calls, failAcquire: false, failSettle: false, busy: false });
}

test("independent browser clients serialize the same company, retain each profile and let different companies save", async () => {
  const coordinator = saveCoordinator(), inserted = new Map();
  let entered, release;
  const writing = new Promise(resolve => { entered = resolve; });
  const save = async (data, options, stored) => {
    const record = stored.jobTrackerResearchV1.find(item => item.requestId === options.requestId);
    assert.equal(record.terminal, false); assert.equal(record.state, "waiting-save"); assert.equal(record.saveClaim.phase, "writing");
    assert.equal(record.saveClaim.destination, FILE_DESTINATION); assert.equal(options.sheetUrl, FILE_DESTINATION);
    assert.equal(record.saveResearch.result.decision, "save");
    if (inserted.has(data.company)) throw Object.assign(new Error("This company already has a recorded job."), { code: "DUPLICATE_COMPANY" });
    inserted.set(data.company, { profile: options.profile, requestId: options.requestId });
    return { inserted: true };
  };
  const first = harness({ destination: FILE_DESTINATION, coordinator, saveImpl: async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return save(...args); } });
  const second = harness({ destination: FILE_DESTINATION, coordinator, saveImpl: save });
  await first.client.start(job, { profile: "kevin" }); await second.client.start(job, { profile: "jagjeet" });
  const firstPoll = first.client.poll(); await writing;
  await second.client.poll();
  assert.equal(second.saves.length, 0); assert.equal(second.stored.jobTrackerResearchV1[0].state, "waiting-save");
  assert.equal(second.reports.at(-1).details.error.code, "SAVE_COORDINATION_BUSY"); assert.equal(second.reports.at(-1).details.willRetry, true);
  const other = harness({ destination: FILE_DESTINATION, coordinator, saveImpl: save });
  const otherJob = { ...job, company: "Another Company", jobId: "456" };
  other.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, company: otherJob.company, application: { ...result.application, company: otherJob.company } } });
  await other.client.start(otherJob, { profile: "jagjeet" }); await other.client.poll();
  assert.equal(other.stored.jobTrackerResearchV1[0].state, "saved"); assert.equal(coordinator.claims.size, 1);
  release(); await firstPoll; await second.client.poll();
  assert.equal(first.stored.jobTrackerResearchV1[0].state, "saved"); assert.equal(second.stored.jobTrackerResearchV1[0].state, "failed");
  assert.equal(second.reports.at(-1).details.error.code, "DUPLICATE_COMPANY");
  assert.deepEqual([...inserted].map(([company, entry]) => [company, entry.profile]).sort(), [["Another Company", "jagjeet"], ["Mews", "kevin"]]);
  assert.equal(coordinator.claims.size, 0);
});

test("busy, unavailable and missing save coordinators fail closed with pending failure reports", async () => {
  for (const scenario of ["busy", "offline", "missing"]) {
    const coordinator = scenario === "missing" ? null : saveCoordinator();
    if (coordinator) coordinator[scenario === "busy" ? "busy" : "failAcquire"] = true;
    const h = harness({ destination: FILE_DESTINATION, coordinator });
    await h.client.start(job); await h.client.poll();
    assert.equal(h.saves.length, 0, scenario); assert.equal(h.stored.jobTrackerResearchV1[0].terminal, false, scenario);
    assert.equal(h.stored.jobTrackerResearchV1[0].state, "waiting-save", scenario); assert.equal(h.reports.at(-1).details.willRetry, true, scenario);
    assert.equal(h.reports.at(-1).details.stage, "save-coordination", scenario);
    assert.equal(h.alarmCalls.at(-1).cleared, undefined, scenario);
  }
});

test("a confirmed save survives settlement outage and a restart only retries its ACK", async () => {
  const coordinator = saveCoordinator(); coordinator.failSettle = true;
  const first = harness({ destination: FILE_DESTINATION, coordinator });
  await first.client.start(job); await first.client.poll();
  const record = first.stored.jobTrackerResearchV1[0];
  assert.equal(record.state, "saved"); assert.equal(record.terminal, true); assert.equal(record.saveClaim.phase, "settle");
  assert.equal(first.reports.length, 0); assert.equal(coordinator.claims.size, 1);
  coordinator.failSettle = false;
  const resumed = harness({ destination: FILE_DESTINATION, coordinator, stored: first.stored }); await resumed.client.poll();
  assert.equal(resumed.saves.length, 0); assert.equal(resumed.stored.jobTrackerResearchV1[0].state, "saved");
  assert.equal(resumed.stored.jobTrackerResearchV1[0].saveClaim, undefined); assert.equal(coordinator.claims.size, 0);
  assert.ok(resumed.calls.every(call => call.url.endsWith("/save-claim"))); assert.equal(resumed.alarmCalls.at(-1).cleared, true);
});

test("a crash after file close replays the same UUID and durable writing claim without fresh research", async () => {
  const coordinator = saveCoordinator(), files = new Map();
  const save = async (data, options) => { const replayed = files.has(options.requestId); if (!replayed) files.set(options.requestId, clone(data)); return { replayed }; };
  const first = harness({ destination: FILE_DESTINATION, coordinator, failResearchWriteAt: 6, saveImpl: save });
  const started = await first.client.start(job, { profile: "kevin" });
  await assert.rejects(first.client.poll(), /Research storage write failed/);
  const record = first.stored.jobTrackerResearchV1[0];
  assert.equal(record.state, "waiting-save"); assert.equal(record.terminal, false); assert.equal(record.saveClaim.phase, "writing");
  assert.equal(files.size, 1); assert.equal(coordinator.claims.size, 1);
  const originalToken = record.saveClaim.token;
  record.createdAt = Date.now() - 48 * 60 * 60 * 1000;
  record.saveResearch.completedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const resumed = harness({ destination: FILE_DESTINATION, coordinator, stored: first.stored, saveImpl: save });
  await resumed.client.poll();
  assert.equal(resumed.saves[0].options.requestId, started.requestId); assert.equal(resumed.saves[0].options.profile, "kevin");
  assert.equal(resumed.saves[0].options.replayOnly, true);
  assert.equal(files.size, 1); assert.equal(resumed.stored.jobTrackerResearchV1[0].state, "saved");
  assert.equal(coordinator.calls.filter(call => call.action === "settle").at(-1).token, originalToken);
  assert.ok(resumed.calls.every(call => call.url.endsWith("/save-claim")), "cached verified findings recover even after worker research pruning");
  assert.equal(coordinator.claims.size, 0);
});

test("a claim is never used before its writing intent is durably stored", async () => {
  const coordinator = saveCoordinator();
  const first = harness({ destination: FILE_DESTINATION, coordinator, failResearchWriteAt: 5 });
  await first.client.start(job); await assert.rejects(first.client.poll(), /Research storage write failed/);
  assert.equal(first.saves.length, 0); assert.equal(coordinator.claims.size, 1); assert.equal(first.stored.jobTrackerResearchV1[0].terminal, false);
  const resumed = harness({ destination: FILE_DESTINATION, coordinator, stored: first.stored }); await resumed.client.poll();
  assert.equal(resumed.saves.length, 1); assert.equal(resumed.stored.jobTrackerResearchV1[0].state, "saved"); assert.equal(coordinator.claims.size, 0);
});

test("filesystem rejection is settled and released after abort before another browser can proceed", async () => {
  const coordinator = saveCoordinator(); let aborted = false;
  const h = harness({ destination: FILE_DESTINATION, coordinator, saveImpl: async () => {
    aborted = true; throw Object.assign(new Error("The job file could not be saved."), { code: "LOCAL_STORE_UNAVAILABLE" });
  } });
  await h.client.start(job); await h.client.poll();
  assert.equal(aborted, true); assert.equal(h.stored.jobTrackerResearchV1[0].state, "waiting-save"); assert.equal(h.stored.jobTrackerResearchV1[0].saveClaim, undefined);
  assert.equal(coordinator.claims.size, 0); assert.equal(coordinator.calls.at(-1).action, "settle"); assert.equal(h.reports.at(-1).details.willRetry, true);
});

test("history trimming retains unacknowledged claims and clearing cancels an interrupted writer without creating files", async () => {
  const coordinator = saveCoordinator(); coordinator.failSettle = true;
  const first = harness({ destination: FILE_DESTINATION, coordinator }); await first.client.start(job); await first.client.poll();
  const saved = clone(first.stored.jobTrackerResearchV1[0]); saved.createdAt = Date.now() - 48 * 60 * 60 * 1000;
  first.stored.jobTrackerResearchV1 = [saved, ...Array.from({ length: 205 }, (_, index) => ({ terminal: true, createdAt: Date.now(), requestId: `old-${index}` }))];
  await first.client.start({ ...job, company: "New Company", jobId: "456" });
  assert.ok(first.stored.jobTrackerResearchV1.some(record => record.requestId === saved.requestId && record.saveClaim));
  await first.client.clear();
  assert.equal(first.stored.jobTrackerResearchV1.length, 1); assert.equal(first.stored.jobTrackerResearchV1[0].state, "saved"); assert.equal(coordinator.claims.size, 1);
  const record = first.stored.jobTrackerResearchV1[0]; record.terminal = false; record.state = "waiting-save"; record.saveClaim.phase = "writing";
  const before = coordinator.calls.length; await first.client.clear();
  assert.equal(coordinator.calls.length, before + 1); assert.equal(first.stored.jobTrackerResearchV1[0].saveClaim.phase, "settle");
  assert.equal(first.stored.jobTrackerResearchV1[0].saveCancelled, true); assert.equal(first.stored.jobTrackerResearchV1[0].state, "cancelled");
  coordinator.failSettle = false;
  await first.client.clear(); assert.equal(first.stored.jobTrackerResearchV1, undefined); assert.equal(coordinator.claims.size, 0);
  assert.equal(first.saves.length, 1, "clear did not retry the interrupted filesystem operation");
});

test("an ambiguous acquired grant survives token-persistence failure and clear recovers its owner only to release it", async () => {
  const coordinator = saveCoordinator();
  const first = harness({ destination: FILE_DESTINATION, coordinator, failResearchWriteAt: 5 });
  await first.client.start(job); await assert.rejects(first.client.poll(), /Research storage write failed/);
  assert.equal(first.stored.jobTrackerResearchV1[0].saveClaim.phase, "acquiring"); assert.equal(coordinator.claims.size, 1);
  const resumed = harness({ destination: FILE_DESTINATION, coordinator, stored: first.stored });
  await resumed.client.clear(); await resumed.client.poll();
  assert.equal(resumed.saves.length, 0); assert.equal(coordinator.claims.size, 0); assert.deepEqual(resumed.stored.jobTrackerResearchV1, []);
});

test("cancelled ownership recovery retries after an outage without saving and changed folders release interrupted claims", async () => {
  for (const cancellation of ["clear", "folder"]) {
    const coordinator = saveCoordinator();
    const first = harness({ destination: FILE_DESTINATION, coordinator, failResearchWriteAt: 5 });
    await first.client.start(job); await assert.rejects(first.client.poll(), /Research storage write failed/);
    coordinator.failAcquire = true;
    const resumed = harness({ destination: FILE_DESTINATION, coordinator, stored: first.stored });
    if (cancellation === "clear") await resumed.client.clear();
    else { resumed.changeSheet(); await resumed.client.poll(); }
    const record = resumed.stored.jobTrackerResearchV1[0];
    assert.equal(record.terminal, true); assert.equal(record.saveCancelled, true); assert.equal(record.saveClaim.phase, "acquiring");
    coordinator.failAcquire = false; await resumed.client.poll();
    assert.equal(resumed.saves.length, 0); assert.equal(coordinator.claims.size, 0); assert.equal(resumed.stored.jobTrackerResearchV1[0].saveClaim, undefined);
  }
});

test("aged interrupted research can replay an existing receipt but cannot create a fresh stale capture", async () => {
  const coordinator = saveCoordinator();
  const first = harness({ destination: FILE_DESTINATION, coordinator, failResearchWriteAt: 5 });
  await first.client.start(job); await assert.rejects(first.client.poll(), /Research storage write failed/);
  first.stored.jobTrackerResearchV1[0].saveResearch.completedAt = new Date(Date.now() - 3600001).toISOString();
  const resumed = harness({ destination: FILE_DESTINATION, coordinator, stored: first.stored, saveImpl: async (_data, options) => {
    assert.equal(options.replayOnly, true); throw Object.assign(new Error("Verified research expired before any file was created."), { code: "RESEARCH_RESULT_EXPIRED" });
  } });
  await resumed.client.poll();
  assert.equal(resumed.stored.jobTrackerResearchV1[0].state, "failed"); assert.equal(resumed.reports.at(-1).details.error.code, "RESEARCH_RESULT_EXPIRED");
  assert.equal(coordinator.claims.size, 0);
});

test("Jobright research uses a distinct provider identity, preserves US routing and requires an external route", async () => {
  const h = harness();
  const id = "123456789012345678901234";
  const linkedin = { ...job, jobId: id, sourceUrl: `https://www.linkedin.com/jobs/view/${id}`, selectedRegion: "us", selectedRegionSource: "search-control", isEasyApply: false };
  const jobright = { ...linkedin, sourceUrl: `https://jobright.ai/jobs/info/${id}`, applyUrl: `https://jobright.ai/jobs/info/${id}` };
  const first = await h.client.start(linkedin);
  const second = await h.client.start(jobright);
  assert.notEqual(first.requestId, second.requestId);
  assert.equal((await h.client.start(jobright)).requestId, second.requestId);
  assert.equal(h.stored.jobTrackerResearchV1.length, 2);
  assert.equal(JSON.parse(h.stored.jobTrackerResearchV1[0].identity)[0], id, "LinkedIn's existing queue identity is preserved");
  assert.equal(JSON.parse(h.stored.jobTrackerResearchV1[1].identity)[0], `jobright:${id}`);
  assert.equal(h.stored.jobTrackerResearchV1[1].job.isEasyApply, true);
  assert.equal(h.stored.jobTrackerResearchV1[1].profileRouting.region, "us");
  assert.equal(JSON.parse(h.calls[1].options.body).job.isEasyApply, true);
});

test("Jobright cannot fall back to a manual profile when its committed US search country is missing", async () => {
  for (const country of [{}, { selectedRegion: "us" }, { selectedRegion: "uk", selectedRegionSource: "search-control" }]) {
    const h = harness();
    await assert.rejects(h.client.start({ ...job, jobId: "123456789012345678901234", sourceUrl: "https://jobright.ai/jobs/info/123456789012345678901234", ...country }, { profile: "kevin" }), /Select United States/);
    assert.equal(h.calls.length, 0); assert.equal(h.stored.jobTrackerResearchV1, undefined);
  }
});

test("model options use the signed-in session catalog and labels with the saved selection", async () => {
  const h = harness({ stored: { jobTrackerResearchModelV1: "session-model-beta" } });
  const options = await h.client.getModels();
  assert.deepEqual(clone(options.models).map(({ id, name }) => ({ id, name })), modelCatalog.models);
  assert.equal(options.defaultModel, "session-model-alpha");
  assert.equal(options.selectedModel, "session-model-beta");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "http://127.0.0.1:8787/job-research/models");
  assert.equal(h.calls[0].options.method, "GET");
  assert.equal(h.calls[0].options.headers["X-Job-Tracker-Extension"], "stable-id");
  assert.match(h.calls[0].options.headers["X-Job-Tracker-Client"], /^[a-f0-9]{64}$/u);
});

test("UI recovery sends only the fixed start action and shares concurrent startup requests", async () => {
  const nativeCalls = []; let ready;
  const pending = new Promise(resolve => { ready = resolve; });
  const h = harness({ stored: { jobTrackerResearchModelV1: "session-model-beta" }, nativeMessaging: async (...args) => { nativeCalls.push(args); return pending; } });
  const first = h.client.startWorker(), second = h.client.startWorker();
  assert.equal(first, second);
  assert.deepEqual(clone(nativeCalls), [["com.applicantally.job_research", { action: "start" }]]);
  ready({ ok: true, status: "ready", alreadyRunning: false });
  assert.deepEqual(clone(await first), { status: "ready", alreadyRunning: false });
  assert.equal(h.stored.jobTrackerResearchModelV1, "session-model-beta");
});

test("missing or failed recovery reports setup/conflict errors without changing queued captures", async () => {
  const missing = harness();
  await assert.rejects(missing.client.startWorker(), error => error.code === "RESEARCH_HELPER_MISSING");
  const h = harness({ networkError: new Error("offline"), nativeMessaging: async () => ({ ok: false, error: { code: "RESEARCH_PORT_CONFLICT", message: "Another service occupies port 8787." } }) });
  await h.client.start(job);
  const queued = clone(h.stored.jobTrackerResearchV1);
  await assert.rejects(h.client.startWorker(), error => error.code === "RESEARCH_PORT_CONFLICT");
  assert.deepEqual(h.stored.jobTrackerResearchV1, queued);
});

test("choosing a model validates against the current catalog and preserves the preference on rejection", async () => {
  const h = harness();
  await h.client.setModel("session-model-beta");
  assert.equal(h.stored.jobTrackerResearchModelV1, "session-model-beta");
  await assert.rejects(h.client.setModel("not-in-this-session"), /model|available/iu);
  assert.equal(h.stored.jobTrackerResearchModelV1, "session-model-beta");
  assert.ok(h.calls.every((call) => call.url.endsWith("/models") && call.options.method === "GET"));
  assert.equal(h.stored.jobTrackerResearchV1, undefined);
  assert.equal((await h.client.getModels()).selectedModel, "session-model-beta");
});

test("resetting to the session default works while the catalog is offline", async () => {
  const h = harness({ stored: { jobTrackerResearchModelV1: "session-model-beta" }, networkError: new Error("connection refused") });
  await h.client.setModel("");
  assert.equal(h.stored.jobTrackerResearchModelV1 || "", "");
  assert.equal(h.calls.length, 0, "reset must not depend on a reachable model catalog");
  h.setNetworkError(null);
  assert.equal((await h.client.getModels()).selectedModel, "");
});

test("an unavailable catalog fails explicitly and leaves existing captures and the model preference intact", async () => {
  const h = harness({ stored: { jobTrackerResearchModelV1: "session-model-alpha" }, catalogError: new Error("catalog connection refused") });
  const started = await h.client.start(job);
  const pending = clone(h.stored.jobTrackerResearchV1);
  await assert.rejects(h.client.getModels(), /unavailable|worker|models/iu);
  await assert.rejects(h.client.setModel("session-model-beta"), /unavailable|worker|models/iu);
  assert.equal(h.stored.jobTrackerResearchModelV1, "session-model-alpha");
  assert.deepEqual(h.stored.jobTrackerResearchV1, pending);
  await h.client.poll();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].options.requestId, started.requestId);
});

test("offline captures freeze their selected model across preference changes, replay and worker restart", async () => {
  const first = harness({ stored: { jobTrackerResearchModelV1: "session-model-alpha" }, networkError: new Error("connection refused") });
  const started = await first.client.start(job, { profile: "Candidate" });
  assert.equal(started.queued, true);
  assert.equal(first.stored.jobTrackerResearchV1[0].model, "session-model-alpha");
  const submitted = JSON.parse(first.calls[0].options.body);
  assert.equal(submitted.model, "session-model-alpha");
  assert.equal(submitted.job.model, undefined);
  assert.equal(submitted.job.privateKey, undefined);
  assert.equal(submitted.job.profile, undefined);
  assert.equal(submitted.profile, undefined);
  first.stored.jobTrackerResearchModelV1 = "session-model-beta";
  const replay = await first.client.start(job, { profile: "Candidate" });
  assert.equal(replay.requestId, started.requestId);
  assert.equal(replay.replayed, true);
  assert.equal(first.calls.length, 1);
  assert.equal(first.stored.jobTrackerResearchV1[0].model, "session-model-alpha");
  const resumed = harness({ stored: first.stored });
  await resumed.client.poll();
  const retried = JSON.parse(resumed.calls[0].options.body);
  assert.equal(retried.requestId, started.requestId);
  assert.equal(retried.model, "session-model-alpha");
  assert.equal(resumed.saves.length, 1);
  assert.equal(resumed.saves[0].options.requestId, started.requestId);
  await resumed.client.start({ ...job, jobId: "456", sourceUrl: "https://www.linkedin.com/jobs/view/456", company: "Different Company" });
  const newRequest = JSON.parse(resumed.calls.at(-1).options.body);
  assert.equal(newRequest.model, "session-model-beta");
  assert.notEqual(newRequest.requestId, started.requestId);
});

test("session-default captures do not acquire a later model preference when their requests are retried", async () => {
  const first = harness({ networkError: new Error("connection refused") });
  const started = await first.client.start(job);
  assert.equal(first.stored.jobTrackerResearchV1[0].model, "");
  assert.equal(Object.hasOwn(JSON.parse(first.calls[0].options.body), "model"), false);
  first.stored.jobTrackerResearchModelV1 = "session-model-beta";
  const resumed = harness({ stored: first.stored });
  await resumed.client.poll();
  const body = JSON.parse(resumed.calls[0].options.body);
  assert.equal(body.requestId, started.requestId);
  assert.equal(Object.hasOwn(body, "model"), false);
  assert.equal(resumed.saves.length, 1);
});

test("legacy queued captures without a model retain their original request shape", async () => {
  const first = harness({ networkError: new Error("connection refused") });
  const started = await first.client.start(job);
  delete first.stored.jobTrackerResearchV1[0].model;
  first.stored.jobTrackerResearchModelV1 = "session-model-beta";
  const resumed = harness({ stored: first.stored });
  await resumed.client.poll();
  const body = JSON.parse(resumed.calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ["job", "requestId"]);
  assert.equal(body.requestId, started.requestId);
  assert.equal(resumed.saves.length, 1);
});

const effortCatalog = { defaultModel: "session-model-alpha", defaultReasoningEffort: "xhigh", models: [
  { id: "session-model-alpha", name: "Research Alpha", reasoningEfforts: ["medium", "high", "xhigh", "ultra"], defaultReasoningEffort: "medium" },
  { id: "session-model-beta", name: "Research Beta", reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }
] };

test("reasoning levels come from the current model catalog, including the session-default model", async () => {
  const h = harness({ catalog: effortCatalog });
  assert.deepEqual(clone(await h.client.setReasoningEffort("ultra")), { selectedModel: "", selectedReasoningEffort: "ultra" });
  const options = await h.client.getModels();
  assert.equal(options.defaultReasoningEffort, "xhigh");
  assert.equal(options.selectedReasoningEffort, "ultra");
  assert.deepEqual(clone(options.models[0].reasoningEfforts), effortCatalog.models[0].reasoningEfforts);
  await h.client.start(job);
  const body = JSON.parse(h.calls.at(-1).options.body);
  assert.equal(Object.hasOwn(body, "model"), false);
  assert.equal(body.reasoningEffort, "ultra");
  assert.equal(body.job.reasoningEffort, undefined);
});

test("model changes retain a supported level or reset it atomically to automatic", async () => {
  const h = harness({ catalog: effortCatalog });
  await h.client.setReasoningEffort("high");
  assert.deepEqual(clone(await h.client.setModel("session-model-beta")), { selectedModel: "session-model-beta", selectedReasoningEffort: "high" });
  assert.deepEqual(clone(await h.client.setModel("")), { selectedModel: "", selectedReasoningEffort: "high" });
  await h.client.setReasoningEffort("ultra");
  const [settings] = await Promise.all([h.client.setModel("session-model-beta"), h.client.start(job)]);
  assert.equal(settings.selectedReasoningEffort, "");
  const captured = h.stored.jobTrackerResearchV1[0];
  assert.equal(captured.model, "session-model-beta");
  assert.equal(captured.reasoningEffort, "");
  assert.equal(h.stored.jobTrackerResearchEffortV1, "");
});

test("unsupported or malformed levels leave the saved model and level intact", async () => {
  const h = harness({ catalog: effortCatalog, stored: { jobTrackerResearchModelV1: "session-model-beta", jobTrackerResearchEffortV1: "high" } });
  await assert.rejects(h.client.setReasoningEffort("ultra"), error => error.code === "RESEARCH_EFFORT_UNAVAILABLE");
  await assert.rejects(h.client.setReasoningEffort({ level: "high" }), error => error.code === "RESEARCH_EFFORT_INVALID");
  assert.equal(h.stored.jobTrackerResearchEffortV1, "high");
  assert.equal(h.stored.jobTrackerResearchModelV1, "session-model-beta");
  h.setNetworkError(new Error("offline"));
  await assert.rejects(h.client.setReasoningEffort("medium"), error => error.retryableResearch === true);
  assert.equal(h.stored.jobTrackerResearchEffortV1, "high");
  assert.equal((await h.client.setReasoningEffort("")).selectedReasoningEffort, "");
});

test("offline captures freeze their model and level across preference changes, replay and extension restart", async () => {
  const first = harness({ stored: { jobTrackerResearchModelV1: "session-model-alpha", jobTrackerResearchEffortV1: "ultra" }, networkError: new Error("offline") });
  const started = await first.client.start(job);
  first.stored.jobTrackerResearchModelV1 = "session-model-beta";
  first.stored.jobTrackerResearchEffortV1 = "medium";
  assert.equal((await first.client.start(job)).requestId, started.requestId);
  const resumed = harness({ stored: first.stored });
  await resumed.client.poll();
  const retried = JSON.parse(resumed.calls[0].options.body);
  assert.equal(retried.requestId, started.requestId);
  assert.equal(retried.model, "session-model-alpha");
  assert.equal(retried.reasoningEffort, "ultra");
  await resumed.client.start({ ...job, jobId: "456", company: "Different Company" });
  const newRequest = JSON.parse(resumed.calls.at(-1).options.body);
  assert.equal(newRequest.model, "session-model-beta");
  assert.equal(newRequest.reasoningEffort, "medium");
});

test("automatic and legacy captures ignore later level preferences and freeze the worker's accepted default", async () => {
  const first = harness({ networkError: new Error("offline") });
  const started = await first.client.start(job);
  delete first.stored.jobTrackerResearchV1[0].reasoningEffort;
  first.stored.jobTrackerResearchEffortV1 = "ultra";
  const resumed = harness({ stored: first.stored, acceptedSettings: { model: "session-model-alpha", reasoningEffort: "xhigh" } });
  resumed.setResponse({ state: "researching" });
  await resumed.client.poll();
  const body = JSON.parse(resumed.calls[0].options.body);
  assert.equal(body.requestId, started.requestId);
  assert.equal(Object.hasOwn(body, "reasoningEffort"), false);
  assert.equal(resumed.stored.jobTrackerResearchV1[0].model, "session-model-alpha");
  assert.equal(resumed.stored.jobTrackerResearchV1[0].reasoningEffort, "xhigh");
});

test("an unavailable research worker queues a durable capture and recovers with the same ID after restart", async () => {
  const first = harness({ networkError: new Error("connection refused") });
  const started = await first.client.start(job, { profile: "Candidate", tabId: 42 });
  assert.equal(started.status, "researching"); assert.equal(started.queued, true);
  assert.equal(first.stored.jobTrackerResearchV1[0].state, "requesting");
  assert.equal(first.stored.jobTrackerResearchV1[0].terminal, undefined);
  assert.equal(first.stored.jobTrackerResearchV1[0].requestId, started.requestId);
  assert.equal(first.alarmCalls.at(-1).options.periodInMinutes, 0.5);
  const replay = await first.client.start(job, { profile: "Candidate" });
  assert.equal(replay.queued, true); assert.equal(replay.replayed, true);
  assert.equal(replay.requestId, started.requestId); assert.equal(first.calls.length, 1);
  assert.equal(first.saves.length, 0);

  const resumed = harness({ stored: first.stored });
  await resumed.client.poll(); await resumed.client.poll();
  assert.equal(JSON.parse(resumed.calls[0].options.body).requestId, started.requestId);
  assert.equal(resumed.saves.length, 1); assert.equal(resumed.saves[0].options.requestId, started.requestId);
  assert.equal(resumed.saves[0].options.profile, "Candidate");
  assert.equal(resumed.stored.jobTrackerResearchV1[0].state, "saved");
});
test("timeouts and temporary HTTP failures retain accepted research requests for retry", async () => {
  for (const status of [408, 429, 502, 503, 504]) {
    const first = harness({ postStatus: status });
    const started = await first.client.start(job);
    assert.equal(started.status, "researching", String(status)); assert.equal(started.queued, true, String(status));
    assert.equal(first.stored.jobTrackerResearchV1[0].state, "requesting", String(status));
    assert.equal(first.stored.jobTrackerResearchV1[0].terminal, undefined, String(status));
    const resumed = harness({ stored: first.stored }); await resumed.client.poll();
    assert.equal(JSON.parse(resumed.calls[0].options.body).requestId, started.requestId, String(status));
    assert.equal(resumed.saves.length, 1, String(status));
  }
  const timeout = harness({ networkError: Object.assign(new Error("Request timed out."), { name: "TimeoutError" }) });
  const queued = await timeout.client.start(job);
  assert.equal(queued.queued, true); assert.equal(timeout.stored.jobTrackerResearchV1[0].state, "requesting");
});
test("a rejected research request fails explicitly rather than masquerading as a queued capture", async () => {
  const h = harness({ postStatus: 422 });
  await assert.rejects(h.client.start(job), (error) => error.status === 422 && error.retryableResearch !== true);
  assert.equal(h.stored.jobTrackerResearchV1[0].terminal, true); assert.equal(h.stored.jobTrackerResearchV1[0].state, "failed");
  await h.client.poll(); assert.equal(h.calls.length, 1); assert.equal(h.saves.length, 0);
});
test("a temporary HTTP failure with a non-JSON response still queues safely", async () => {
  const h = harness({ postStatus: 503, postJsonError: new SyntaxError("Unexpected HTML error page.") });
  const queued = await h.client.start(job);
  assert.equal(queued.status, "researching"); assert.equal(queued.queued, true);
  assert.equal(h.stored.jobTrackerResearchV1[0].state, "requesting"); assert.equal(h.saves.length, 0);
});
test("research storage failures before or after submission are not swallowed as service outages", async () => {
  for (const failResearchWriteAt of [1, 2]) {
    const h = harness({ failResearchWriteAt });
    await assert.rejects(h.client.start(job), /Research storage write failed/);
    assert.equal(h.calls.length, failResearchWriteAt - 1);
    assert.equal(h.saves.length, 0);
    if (failResearchWriteAt === 2) assert.equal(h.stored.jobTrackerResearchV1[0].state, "requesting");
  }
  const keyFailure = harness({ failClientKeyWrite: true });
  await assert.rejects(keyFailure.client.start(job), /Browser client key storage write failed/);
  assert.equal(keyFailure.calls.length, 0); assert.equal(keyFailure.saves.length, 0);
});
test("an offline poll checks the worker once instead of blocking behind every pending capture", async () => {
  for (const pendingState of ["requesting", "researching"]) {
    const h = harness();
    await h.client.start(job);
    await h.client.start({ ...job, jobId: "456", sourceUrl: "https://www.linkedin.com/jobs/view/456", company: "Other Company" });
    for (const record of h.stored.jobTrackerResearchV1) record.state = pendingState;
    h.calls.length = 0; h.setNetworkError(new Error("connection refused"));
    await h.client.poll();
    assert.equal(h.calls.length, 1, pendingState); assert.equal(h.saves.length, 0);
    assert.equal(h.stored.jobTrackerResearchV1.length, 2);
    assert.ok(h.stored.jobTrackerResearchV1.every((record) => !record.terminal && record.state === pendingState));
  }
});
test("a local outage retries the same capture after worker recovery without duplicating it", async () => {
  const first = harness({ saveError: Object.assign(new Error("offline"), { code: "LOCAL_STORE_UNAVAILABLE" }) });
  const started = await first.client.start(job, { profile: "Candidate" }); await first.client.poll();
  assert.equal(first.stored.jobTrackerResearchV1[0].terminal, false);
  assert.equal(first.stored.jobTrackerResearchV1[0].state, "waiting-save");
  const resumed = harness({ stored: first.stored }); await resumed.client.poll(); await resumed.client.poll();
  assert.equal(resumed.saves.length, 1); assert.equal(resumed.saves[0].options.requestId, started.requestId);
  assert.equal(resumed.stored.jobTrackerResearchV1[0].state, "saved");
});
test("research persists first, sends only public job fields, then writes verified URL and Info once", async () => {
  const h = harness();
  const started = await h.client.start(job, { profile: "Candidate", tabId: 42 });
  assert.equal(started.status, "researching"); assert.equal(h.saves.length, 0);
  assert.equal(h.calls[0].url, "http://127.0.0.1:8787/job-research");
  const body = JSON.parse(h.calls[0].options.body);
  assert.equal(body.job.privateKey, undefined); assert.equal(body.job.profile, undefined);
  assert.equal(h.calls[0].options.redirect, "error");
  const again = await h.client.start(job, { profile: "Candidate" }); assert.equal(again.replayed, true);
  assert.equal(h.calls.length, 1);
  await h.client.poll(); await h.client.poll();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0].data.applyUrl, result.application.url);
  assert.ok(h.saves[0].data.info.includes(job.sourceUrl)); assert.equal(h.saves[0].options.profile, "Candidate");
  assert.deepEqual(h.remembered, ["Mews"]); assert.equal(h.stored.jobTrackerResearchV1[0].state, "saved");
});

test("model-capacity backoff remains pending until verified research completes with the frozen US profile routing", async () => {
  const h = harness();
  const started = await h.client.start({ ...job, selectedRegion: "us", profileRoutingVersion: 1 });
  const routing = clone(h.stored.jobTrackerResearchV1[0].profileRouting);
  h.setResponse({ state: "queued", retryableResearch: true, retryAt: Date.now() + 60_000,
    retryCount: 2, error: "Selected model is at capacity." });
  await h.client.poll(); await h.client.poll();
  assert.equal(h.saves.length, 0); assert.equal(h.outcomes.length, 0);
  assert.notEqual(h.stored.jobTrackerResearchV1[0].terminal, true);
  assert.deepEqual(h.stored.jobTrackerResearchV1[0].profileRouting, routing);
  h.setResponse({ state: "completed", completedAt: new Date().toISOString(),
    result: { ...result, experience: { minimumYears: null, scope: "ordinary", evidence: duties } } });
  await h.client.poll(); await h.client.poll();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].options.requestId, started.requestId);
  assert.equal(h.saves[0].options.profile, "jagjeet");
});

test("excluded roles never submit research and legacy pending exclusions cannot poll or write", async () => {
  const h = harness();
  assert.equal((await h.client.start({ ...job, title: "Business Analyst", workplaceType: "hybrid" })).status, "skipped");
  assert.equal(h.calls.length, 0); assert.equal(h.saves.length, 0);
  await h.client.start(job);
  h.stored.jobTrackerResearchV1[0].job.title = "Business Analyst";
  h.calls.length = 0; await h.client.poll();
  assert.equal(h.calls.length, 0); assert.equal(h.saves.length, 0);
  assert.equal(h.stored.jobTrackerResearchV1[0].state, "skipped");
  assert.match(h.outcomes[0], /outside software engineering/);
});

test("above-Senior title exclusions never submit and existing queued captures cannot poll or save", async () => {
  for (const title of ["Staff Software Engineer", "Senior Staff Engineer", "Principal Software Engineer",
    "Distinguished Engineer", "Engineering Fellow", "Staff SRE", "Principal Technical Architect",
    "Software Engineer – Staff", "Software Engineer (Principal)", "SRE, Staff", "Director of Engineering", "Head of Engineering", "CTO"]) {
    const h = harness();
    const started = await h.client.start({ ...job, title });
    assert.equal(started.status, "skipped", title);
    assert.equal(h.calls.length, 0, title);
    assert.equal(h.saves.length, 0, title);
    assert.equal(h.stored.jobTrackerResearchV1, undefined, title);
  }
  for (const pendingState of ["requesting", "researching", "waiting-save"]) {
    const first = harness();
    await first.client.start(job, { profile: "kevin" });
    const record = first.stored.jobTrackerResearchV1[0];
    record.job.title = "Staff Software Engineer";
    record.state = pendingState;
    const resumed = harness({ stored: first.stored });
    await resumed.client.poll(); await resumed.client.poll();
    assert.equal(resumed.calls.length, 0, pendingState);
    assert.equal(resumed.saves.length, 0, pendingState);
    assert.equal(resumed.stored.jobTrackerResearchV1[0].terminal, true, pendingState);
    assert.equal(resumed.stored.jobTrackerResearchV1[0].state, "skipped", pendingState);
    assert.equal(resumed.outcomes.length, 1, pendingState);
  }
});

test("Associate and entry-level captures are excluded, and previously queued ones are logged without polling or saving", async () => {
  for (const title of ["Associate Software Engineer", "Junior Software Engineer", "Entry-Level Developer", "Graduate Software Engineer", "Software Engineering Intern"]) {
    const h = harness();
    assert.equal((await h.client.start({ ...job, title })).status, "skipped", title);
    assert.equal(h.calls.length, 0, title); assert.equal(h.saves.length, 0, title);
  }
  for (const pendingState of ["requesting", "researching", "waiting-save"]) {
    const first = harness(); await first.client.start(job);
    first.stored.jobTrackerResearchV1[0].job.title = "Associate Software Engineer";
    first.stored.jobTrackerResearchV1[0].state = pendingState;
    const resumed = harness({ stored: first.stored }); await resumed.client.poll(); await resumed.client.poll();
    assert.equal(resumed.calls.length, 0); assert.equal(resumed.saves.length, 0);
    assert.equal(resumed.reports.length, 1); assert.equal(resumed.reports[0].details.stage, "local-policy");
    assert.match(resumed.reports[0].details.reason, /Associate or entry-level/);
  }
});

test("AI-detected entry-level scope in a generic title preserves the exact skip reason and evidence in reports", async () => {
  const h = harness(); await h.client.start(job);
  const findings = { decision: "skip", company: job.company, title: job.title,
    role: { eligible: false, category: "software-development", evidence: duties, reason: "Entry-level engineering scope." },
    reason: "The position is a graduate training placement with supervised starter tasks." };
  h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: findings }); await h.client.poll();
  assert.equal(h.saves.length, 0); assert.equal(h.reports[0].details.stage, "ai-decision");
  assert.equal(h.reports[0].details.reason, findings.reason);
  assert.deepEqual(h.reports[0].details.research.result, findings);
});

test("Lead roles are excluded before research and previously queued Lead captures produce skip reports", async () => {
  for (const title of ["Technical Lead", "Tech Lead", "Team Lead", "Lead Software Engineer", "Engineering Lead", "Software Engineer (Lead)"]) {
    const h = harness(); assert.equal((await h.client.start({ ...job, title })).status, "skipped");
    assert.equal(h.calls.length, 0); assert.equal(h.saves.length, 0);
  }
  for (const state of ["requesting", "researching", "waiting-save"]) {
    const first = harness(); await first.client.start(job);
    first.stored.jobTrackerResearchV1[0].job.title = "Technical Lead";
    first.stored.jobTrackerResearchV1[0].state = state;
    const resumed = harness({ stored: first.stored }); await resumed.client.poll(); await resumed.client.poll();
    assert.equal(resumed.calls.length, 0); assert.equal(resumed.saves.length, 0);
    assert.equal(resumed.reports.length, 1); assert.match(resumed.reports[0].details.reason, /Lead role/);
    assert.equal(resumed.stored.jobTrackerResearchV1[0].state, "skipped");
  }
});

test("old queued descriptions assigning this role Staff equivalence are discarded before worker calls", async () => {
  for (const pendingState of ["requesting", "researching", "waiting-save"]) {
    const first = harness();
    await first.client.start(job, { profile: "kevin" });
    const record = first.stored.jobTrackerResearchV1[0];
    record.job.description += " This position is equivalent to Staff Engineer level.";
    record.state = pendingState;
    const resumed = harness({ stored: first.stored });
    await resumed.client.poll(); await resumed.client.poll();
    assert.equal(resumed.calls.length, 0, pendingState);
    assert.equal(resumed.saves.length, 0, pendingState);
    assert.equal(resumed.stored.jobTrackerResearchV1[0].terminal, true, pendingState);
    assert.equal(resumed.stored.jobTrackerResearchV1[0].state, "skipped", pendingState);
    assert.deepEqual(resumed.outcomes, ["Skipped: role is above Senior level."], pendingState);
  }
});

test("AI rejects above-Senior scope in ordinary titles before choosing a profile or saving", async () => {
  const evidence = "Set the company-wide engineering strategy and technical standards across multiple engineering teams.";
  for (const title of ["Software Engineer", "Technical Architect"]) {
    const h = harness();
    await h.client.start({ ...job, title, description: evidence, selectedRegion: "us", isEasyApply: false });
    assert.equal(h.calls.length, 1, title);
    h.setResponse({ state: "completed", completedAt: new Date().toISOString(),
      result: { decision: "save", company: job.company, title,
        role: { eligible: false, category: "software-development", evidence,
          reason: "Above-Senior scope: company-wide technical strategy across multiple teams." } } });
    await h.client.poll(); await h.client.poll();
    assert.equal(h.saves.length, 0, title);
    assert.equal(h.stored.jobTrackerResearchV1[0].terminal, true, title);
    assert.equal(h.stored.jobTrackerResearchV1[0].state, "skipped", title);
    assert.equal(h.stored.jobTrackerResearchV1[0].profileSelection, undefined, title);
  }
});

test("ordinary Remote JavaScript and .NET roles research first and cannot save a legacy or unclear classification", async () => {
  for (const title of ["Senior JavaScript Engineer", ".NET Developer"]) {
    for (const classification of [undefined, { eligible: false, category: "unclear", reason: "Primary duties are unclear." }, role]) {
      const h = harness();
      await h.client.start({ ...job, title, isEasyApply: false });
      assert.equal(h.calls.length, 1); assert.equal(h.saves.length, 0);
      h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, title, application: undefined, role: classification } });
      await h.client.poll();
      assert.equal(h.saves.length, classification === role ? 1 : 0);
      if (classification !== role) {
        assert.equal(h.outcomes[0], "Skipped: software engineering role not confirmed.");
        assert.equal(h.stored.jobTrackerResearchV1[0].terminal, true);
        assert.equal(h.stored.jobTrackerResearchV1[0].state, "skipped");
      }
    }
  }
});
test("skips, invalid callbacks, expired findings and changed Sheet targets never write", async () => {
  const responses = [
    { ...result, decision: "skip" }, { ...result, title: "Similar role" }, { ...result, application: { ...result.application, free: false } }
  ];
  for (const value of responses) {
    const h = harness(); await h.client.start(job); h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: value });
    await h.client.poll(); assert.equal(h.saves.length, 0);
  }
  const stale = harness(); await stale.client.start(job); stale.setResponse({ state: "completed", completedAt: new Date(Date.now() - 7200000).toISOString(), result });
  await stale.client.poll(); assert.equal(stale.saves.length, 0);
  const changed = harness(); await changed.client.start(job); changed.changeSheet(); await changed.client.poll(); assert.equal(changed.saves.length, 0); assert.equal(changed.calls.length, 1);
});
test("research submission recovery reuses the same ID without replaying an uncertain Sheet write", async () => {
  const h = harness({ failPostOnce: true, saveError: Object.assign(new Error("Unconfirmed save"), { code: "TRACKER_SAVE_UNCONFIRMED" }) });
  const started = await h.client.start(job);
  assert.equal(started.status, "researching"); assert.equal(started.queued, true);
  const id = h.stored.jobTrackerResearchV1[0].requestId;
  await h.client.poll(); await h.client.poll();
  assert.equal(JSON.parse(h.calls[1].options.body).requestId, id);
  assert.equal(h.saves.length, 1); assert.equal(h.stored.jobTrackerResearchV1[0].state, "save-unconfirmed");
});
test("a completed email-only result saves the published address and rechecks the banned list", async () => {
  const emails = [{ email: "hiring@mews.com", company: "Mews", kind: "application", source: "description", sourceQuote: "Apply to hiring@mews.com." }];
  const h = harness(); await h.client.start(job); h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, application: undefined, emails } });
  await h.client.poll(); assert.equal(h.saves[0].data.applyUrl, job.applyUrl); assert.match(h.saves[0].data.info, /hiring@mews.com/);
  const blocked = harness(); await blocked.client.start(job); blocked.ban(); await blocked.client.poll(); assert.equal(blocked.saves.length, 0);
});
test("a completed email application page writes the page URL to Apply URL and keeps the address and LinkedIn source in Info", async () => {
  const h = harness();
  const descriptionEvidence = "Our mobile audience already uses this established sports data platform, and this role will turn its React Native prototype into production iOS and Android apps.";
  const target = { ...job, description: `${duties} ${descriptionEvidence}` };
  await h.client.start(target);
  const page = { ...result.application, route: "email", title: "Mobile Product Builder", descriptionEvidence,
    evidence: "Apply now by emailing hiring@mews.com." };
  h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, application: page,
    emails: [{ email: "hiring@mews.com", company: "Mews", kind: "application", source: "public", sourceUrl: page.url, sourceQuote: page.evidence }] } });
  await h.client.poll();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0].data.applyUrl, page.url);
  assert.equal(h.saves[0].data.info, `LinkedIn job: ${job.sourceUrl} | Application email: hiring@mews.com`);
});
test("pending research resumes after a worker restart and removing settings cancels it", async () => {
  const first = harness(); await first.client.start(job);
  const next = harness({ stored: first.stored }); await next.client.poll(); assert.equal(next.saves.length, 1);
  const cleared = harness(); await cleared.client.start(job); await cleared.client.clear(); await cleared.client.poll(); assert.equal(cleared.saves.length, 0);
});

test("AI skips report the exact reason, frozen choices and prompt diagnostics", async () => {
  const h = harness({ stored: { jobTrackerResearchModelV1: "session-model-alpha", jobTrackerResearchEffortV1: "high" } });
  const started = await h.client.start(job);
  const research = { state: "completed", completedAt: new Date().toISOString(), threadId: "task-1", turnId: "turn-1",
    result: { decision: "skip", company: job.company, title: job.title, reason: "The job requires mandatory office attendance.", role },
    diagnostics: { prompt: "Classify the exact captured description.", events: [{ type: "decision", reason: "Mandatory office attendance." }] } };
  h.setResponse(research); await h.client.poll(); await h.client.poll();
  assert.equal(h.saves.length, 0); assert.equal(h.reports.length, 1);
  const report = h.reports[0];
  assert.equal(report.record.requestId, started.requestId);
  assert.equal(report.record.model, "session-model-alpha"); assert.equal(report.record.reasoningEffort, "high");
  assert.equal(report.record.job.description, job.description);
  assert.equal(report.details.stage, "ai-decision"); assert.equal(report.details.reason, research.result.reason);
  assert.deepEqual(report.details.research, research); assert.equal(h.outcomes[0], research.result.reason);
});

test("verification reports distinguish invalid evidence, identity and stale results from an AI skip", async () => {
  const cases = [
    [{ ...result, role: { eligible: true, category: "software-development", evidence: "Invented engineering duties that are absent from the job." } }, "ROLE_EVIDENCE_INVALID"],
    [{ ...result, title: "Another Role" }, "RESEARCH_IDENTITY_MISMATCH"],
    [{ ...result, application: undefined }, "APPLICATION_EVIDENCE_INVALID"]
  ];
  for (const [findings, code] of cases) {
    const h = harness(); await h.client.start(job);
    h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: findings }); await h.client.poll();
    assert.equal(h.reports[0].details.error.code, code); assert.equal(h.reports[0].details.research.result.decision, "save");
  }
  const stale = harness(); await stale.client.start(job);
  stale.setResponse({ state: "completed", completedAt: new Date(Date.now() - 7200000).toISOString(), result }); await stale.client.poll();
  assert.equal(stale.reports[0].details.error.code, "RESEARCH_RESULT_EXPIRED");
});

test("worker failure and request rejection reports retain the actual error", async () => {
  const failed = harness(); await failed.client.start(job);
  failed.setResponse({ state: "failed", error: "The model cannot access this job's application page.", diagnostics: { events: [{ type: "callback-rejected", reason: "Role quote was invented." }] } });
  await failed.client.poll();
  assert.equal(failed.reports[0].details.status, "failed"); assert.equal(failed.reports[0].details.reason, "The model cannot access this job's application page.");
  assert.equal(failed.reports[0].details.research.diagnostics.events[0].reason, "Role quote was invented.");
  const rejected = harness({ postStatus: 400 }); await assert.rejects(rejected.client.start(job));
  assert.equal(rejected.reports[0].details.stage, "submission"); assert.match(rejected.reports[0].details.reason, /rejected/);
});

test("capacity and folder save outages are reported as pending and remain retryable", async () => {
  const h = harness(); await h.client.start(job);
  h.setResponse({ state: "queued", error: "The current model is at capacity.", retryCount: 1, retryAt: Date.now() + 30000 });
  await h.client.poll(); await h.client.poll();
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0].details.status, "pending"); assert.equal(h.reports[0].details.willRetry, true);
  assert.equal(h.stored.jobTrackerResearchV1[0].terminal, undefined);
  const waiting = harness({ saveError: Object.assign(new Error("Folder permission expired."), { code: "LOCAL_STORE_UNAVAILABLE" }) });
  await waiting.client.start(job); await waiting.client.poll();
  assert.equal(waiting.reports[0].details.stage, "save"); assert.equal(waiting.reports[0].details.status, "pending");
  assert.equal(waiting.stored.jobTrackerResearchV1[0].terminal, false);
});

test("cancelled and expired queues report why they stopped", async () => {
  const changed = harness(); await changed.client.start(job); changed.changeSheet(); await changed.client.poll();
  assert.equal(changed.reports[0].details.status, "cancelled"); assert.match(changed.reports[0].details.reason, /destination changed/);
  const expired = harness(); await expired.client.start(job); expired.stored.jobTrackerResearchV1[0].createdAt = Date.now() - 86400001;
  await expired.client.poll(); assert.match(expired.reports[0].details.reason, /24 hours/);
  const cleared = harness(); await cleared.client.start(job); await cleared.client.clear();
  assert.equal(cleared.reports[0].details.status, "cancelled"); assert.match(cleared.reports[0].details.reason, /cleared by the user/);
});

test("reporting and post-save notification failures cannot turn a confirmed save into failure", async () => {
  const skipped = harness({ reportError: new Error("Report folder inaccessible") }); await skipped.client.start(job);
  skipped.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, decision: "skip", reason: "No verified application route." } });
  await skipped.client.poll(); assert.equal(skipped.stored.jobTrackerResearchV1[0].state, "skipped");
  const saved = harness({ afterSaveError: new Error("UI unavailable") }); await saved.client.start(job); await saved.client.poll();
  assert.equal(saved.saves.length, 1); assert.equal(saved.stored.jobTrackerResearchV1[0].state, "saved"); assert.equal(saved.reports.length, 0);
});

test("Hybrid with no fully remote offer starts a session and waits for its MCP decision, including after a restart", async () => {
  for (const isEasyApply of [true, false]) {
    const h = harness();
    const invalid = { ...job, workplaceType: "hybrid", isEasyApply, description: `${duties} Hybrid: two days at home per week. Apply to hiring@mews.com.` };
    assert.equal((await h.client.start(invalid)).status, "researching");
    assert.equal(h.calls.length, 1); assert.equal(h.saves.length, 0);
    h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, decision: "skip", fullyRemote: false } });
    await h.client.poll(); assert.equal(h.saves.length, 0);

    for (const pendingState of ["requesting", "researching"]) {
      const first = harness(); await first.client.start(invalid);
      const record = first.stored.jobTrackerResearchV1[0];
      record.state = pendingState;
      const reloaded = harness({ stored: first.stored });
      reloaded.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, fullyRemote: true, remoteEvidence: invalid.description } });
      await reloaded.client.poll();
      assert.equal(reloaded.calls.length, pendingState === "requesting" ? 2 : 1); assert.equal(reloaded.saves.length, 0);
      assert.equal(reloaded.stored.jobTrackerResearchV1[0].state, "skipped");
      assert.match(reloaded.outcomes[0], /fully remote/);
    }
  }
});

test("different jobs have different requests while retries of the same pending job retain its session", async () => {
  const h = harness();
  const first = await h.client.start(job);
  const second = await h.client.start({ ...job, jobId: "456", sourceUrl: "https://www.linkedin.com/jobs/view/456", title: "Software Engineer" });
  const retry = await h.client.start(job);
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(retry.requestId, first.requestId); assert.equal(retry.replayed, true);
  assert.equal(h.calls.length, 2); assert.equal(h.saves.length, 0);
});

test("Hybrid with an explicit fully remote offer still researches Easy Apply and saves only with supporting evidence", async () => {
  const h = harness(); await h.client.start({ ...job, workplaceType: "hybrid" });
  h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, fullyRemote: true, remoteEvidence: "This role is fully remote." } });
  await h.client.poll();
  assert.equal(h.saves.length, 1); assert.match(h.saves[0].data.info, /Fully remote confirmed/);
});

test("the search country overrides the remembered profile without sharing candidate settings", async () => {
  for (const [selectedRegion, expected] of [["uk", "michal-stefanow-2page"], ["colombia", "jose-ibero-2page"], ["latam", "jose-ibero-2page"]]) {
    const h = harness();
    const target = { ...job, sourceUrl: `${job.sourceUrl}?geoId=103644278`, selectedRegion, selectedRegionSource: "search-control" };
    const started = await h.client.start(target, { profile: "kevin" });
    assert.equal(started.profile, expected);
    const payload = JSON.parse(h.calls[0].options.body);
    assert.equal(payload.job.selectedRegion, selectedRegion); assert.equal(payload.job.selectedRegionSource, "search-control");
    assert.equal(payload.job.profileRoutingVersion, 1); assert.equal(payload.job.profile, undefined); assert.equal(payload.job.profiles, undefined);
    await h.client.poll(); assert.equal(h.saves[0].options.profile, expected); assert.equal(h.saves[0].options.trashed, undefined);
  }
});

test("US required years and no-years scope choose Kevin or Jagjeet without automatic Trash", async () => {
  for (const [minimumYears, title, evidence, scope, expected] of [
    [3, "Senior Software Engineer", "3 years of software engineering experience required; 5 years preferred.", "senior", "jagjeet"],
    [4, "Senior Software Engineer", "4–7 years of professional software engineering experience required.", "senior", "jagjeet"],
    [5, "Software Engineer", "5+ years of professional software engineering experience required.", "ordinary", "kevin"],
    [null, "Forward Deployed Engineer", "Own complex data migrations from legacy EHRs and billing systems, end to end", "senior", "kevin"],
    [null, "Software Engineer", "Implement features within the existing architecture and maintain unit tests.", "ordinary", "jagjeet"],
    [null, "Senior Software Engineer", "Implement features within the existing architecture and maintain unit tests.", "ordinary", "kevin"]
  ]) {
    const h = harness();
    const target = { ...job, title, isEasyApply: false, selectedRegion: "us", description: `${job.description} ${evidence}${minimumYears === null ? " No minimum years of experience." : ""}` };
    const started = await h.client.start(target, { profile: "jose-ibero-2page" });
    const retry = await h.client.start(target, { profile: "different-profile" });
    assert.equal(retry.requestId, started.requestId); assert.equal(h.calls.length, 1);
    h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { decision: "save", company: target.company, title, role, experience: { minimumYears, scope, evidence } } });
    await h.client.poll(); assert.equal(h.saves[0].options.profile, expected); assert.equal(h.saves[0].options.trashed, undefined);
    assert.doesNotMatch(h.outcomes[0], /Trash/);
  }
});

test("US evidence is required; retries retain the selected profile and discard retired Trash flags", async () => {
  const evidence = "5+ years of professional software development experience required.";
  const target = { ...job, selectedRegion: "us", description: `${job.description} ${evidence}` };
  const missing = harness(); await missing.client.start(target); await missing.client.poll();
  assert.equal(missing.saves.length, 0); assert.match(missing.outcomes[0], /experience requirements could not be confirmed/);
  const first = harness({ saveError: Object.assign(new Error("offline"), { code: "LOCAL_STORE_UNAVAILABLE" }) });
  const started = await first.client.start(target);
  first.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, experience: { minimumYears: 5, scope: "ordinary", evidence } } });
  await first.client.poll(); assert.equal(first.stored.jobTrackerResearchV1[0].profile, "kevin");
  first.stored.jobTrackerResearchV1[0].saveTrashed = true; first.stored.jobTrackerResearchV1[0].profileSelection.trashed = true;
  const resumed = harness({ stored: first.stored, profiles: ["other-profile"] }); await resumed.client.poll();
  assert.equal(resumed.saves[0].options.profile, "kevin"); assert.equal(resumed.saves[0].options.requestId, started.requestId);
  assert.equal(resumed.saves[0].options.trashed, undefined); assert.equal(resumed.stored.jobTrackerResearchV1[0].saveTrashed, undefined);
  assert.equal(resumed.stored.jobTrackerResearchV1[0].profileSelection.trashed, undefined);
});
