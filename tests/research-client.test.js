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
function harness({ stored = {}, saveError = null, failPostOnce = false } = {}) {
  const calls = [], saves = [], outcomes = [], remembered = [];
  let state = { configured: true, sheetUrl: "https://docs.google.com/spreadsheets/d/aaa/edit#gid=1" };
  let response = { state: "completed", completedAt: new Date().toISOString(), result };
  let banned = false;
  const storage = { async get(key) { return { [key]: clone(stored[key]) }; }, async set(values) { Object.assign(stored, clone(values)); }, async remove(key) { delete stored[key]; } };
  const alarms = { async create() {}, async clear() {} };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options: { ...options, signal: undefined } });
    if (options.method === "POST") {
      if (failPostOnce) { failPostOnce = false; throw new Error("connection lost"); }
      return { ok: true, json: async () => ({ state: "researching" }) };
    }
    return { ok: true, json: async () => clone(response) };
  };
  const sheetClient = { async getStatus() { return clone(state); }, async saveJob(data, options) { saves.push(clone({ data, options })); if (saveError) throw saveError; return { status: "inserted" }; } };
  const context = vm.createContext({ URL, AbortSignal, Uint8Array, Date, fetch: fetchImpl, crypto, chrome: { storage: { local: storage }, alarms, runtime: { id: "stable-id" } } });
  for (const name of ["capture-policy", "research-client"]) vm.runInContext(fs.readFileSync(require.resolve(`../src/${name}.js`), "utf8"), context);
  const client = context.JobResearchClient.create({ storage, fetchImpl, cryptoImpl: crypto, alarms, extensionId: "stable-id", sheetClient,
    bannedCompanies: { async has() { return banned; } }, onSaved: async (company) => remembered.push(company), onOutcome: async (_record, message) => outcomes.push(message) });
  return { client, stored, calls, saves, outcomes, remembered, setResponse(value) { response = value; }, changeSheet() { state.sheetUrl += "different"; }, ban() { banned = true; } };
}
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

test("ordinary Remote JavaScript and .NET roles research first and cannot save a legacy or unclear classification", async () => {
  for (const title of ["Senior JavaScript Engineer", ".NET Developer"]) {
    for (const classification of [undefined, { eligible: false, category: "unclear", reason: "Primary duties are unclear." }, role]) {
      const h = harness();
      await h.client.start({ ...job, title, isEasyApply: false });
      assert.equal(h.calls.length, 1); assert.equal(h.saves.length, 0);
      h.setResponse({ state: "completed", completedAt: new Date().toISOString(), result: { ...result, title, application: undefined, role: classification } });
      await h.client.poll();
      assert.equal(h.saves.length, classification === role ? 1 : 0);
      if (classification !== role) assert.equal(h.outcomes[0], "Skipped: software engineering role not confirmed.");
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
  await assert.rejects(h.client.start(job), /unavailable/);
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
