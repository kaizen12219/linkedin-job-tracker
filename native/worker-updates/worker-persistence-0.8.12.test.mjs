import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { JobResearchService } from "../job-research.js";
import { DesktopCodexDispatcher } from "../lib/tracker-desktop-dispatcher.mjs";
import { createAtomicFileWriter, isRetryableAtomicReplaceError } from "../lib/atomic-file-store.mjs";

const job = {
  company: "Retry Test Company", title: "Software Engineer",
  description: "Build and maintain backend software services and automated tests. This role is fully remote.",
  workplaceType: "remote", isEasyApply: true, sourceUrl: "https://www.linkedin.com/jobs/view/987654321",
  applyUrl: "https://www.linkedin.com/jobs/view/987654321", jobId: "987654321",
  selectedRegion: "us", selectedRegionSource: "search-control", profileRoutingVersion: 1
};
const skip = { decision: "skip", company: job.company, title: job.title, reason: "No verified active application route." };
async function desktopFixture(t, { writeAtomic } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "research-retry-desktop-"));
  const requests = [];
  const turns = [];
  let now = Date.parse("2026-10-13T00:00:00Z");
  const client = {
    connected: true, async start() {}, async close() {}, waitForTurn: () => new Promise(() => {}),
    async request(method, params) {
      requests.push({ method, params });
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "model/list") return { data: [{ id: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }], inputModalities: ["text", "image"] }] };
      if (method === "mcpServerStatus/list") return { data: [{ name: "tracker_resume_builder", tools: { complete_job_capture: {} } }] };
      if (method === "thread/start") return { thread: { id: "capacity-thread", turns: [] }, model: params.model, reasoningEffort: params.config.model_reasoning_effort };
      if (["thread/resume", "thread/read"].includes(method)) return { thread: { id: "capacity-thread", turns: structuredClone(turns) } };
      if (method === "thread/turns/list") return { data: structuredClone(turns) };
      if (method === "turn/start") {
        const turn = { id: `capacity-turn-${turns.length + 1}`, status: "inProgress", clientUserMessageId: params.clientUserMessageId };
        turns.push(turn); return { turn: structuredClone(turn) };
      }
      return {};
    }
  };
  const dispatchers = [];
  const makeDispatcher = () => {
    const value = new DesktopCodexDispatcher({ runtimeDir: directory, codexExecutable: process.execPath, clientFactory: async () => client, clock: () => now, writeAtomic });
    dispatchers.push(value); return value;
  };
  const dispatcher = makeDispatcher();
  t.after(async () => { for (const value of dispatchers) await value.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const operationId = "research-capacity-retry-123";
  const options = { operationId, workflow: "research", title: "Research capacity regression" };
  const submit = extra => dispatcher.dispatch("Research this exact captured job and call complete_job_capture.", { ...options, ...extra });
  const failTurn = async (message = "Selected model is at capacity.") => {
    const turn = turns.at(-1); turn.status = "failed"; turn.error = { message };
    await assert.rejects(dispatcher.completeTurn(client, operationId, await dispatcher.operation(operationId), turn));
    return turn;
  };
  return { directory, dispatcher, makeDispatcher, client, requests, turns, operationId, submit, failTurn, advance(ms) { now += ms; } };
}
async function atomicFixture(t, { rename, wait = async () => {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "research-atomic-"));
  const renames = [], unlinks = [], writes = [], waits = [];
  const writer = createAtomicFileWriter({ fileSystem: { ...fs,
    async writeFile(file, data, options) { writes.push({ file, data, options }); return fs.writeFile(file, data, options); },
    async rename(from, to) { renames.push({ from, to }); return rename ? rename(from, to, renames.length) : fs.rename(from, to); },
    async unlink(file) { unlinks.push(file); return fs.unlink(file); }
  }, wait: async milliseconds => { waits.push(milliseconds); return wait(milliseconds); } });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "requests.json"), writer, renames, unlinks, writes, waits };
}

test("atomic research persistence retries only temporary Windows replacement locks and keeps the prior file intact", async t => {
  let h;
  h = await atomicFixture(t, { rename: async (from, to, attempt) => {
    if (attempt <= 3) throw Object.assign(new Error("File is temporarily busy"), { code: ["EPERM", "EACCES", "EBUSY"][attempt - 1] });
    return fs.rename(from, to);
  }, wait: async () => { assert.equal(await fs.readFile(h.file, "utf8"), "previous"); } });
  await fs.writeFile(h.file, "previous");
  await h.writer(h.file, () => "updated");
  assert.equal(await fs.readFile(h.file, "utf8"), "updated");
  assert.deepEqual(h.waits, [25, 50, 100]);
  assert.equal(new Set(h.renames.map(value => value.from)).size, 1, "retry the closed same temp file rather than reconstruct or unlink the destination");
  assert.ok(h.unlinks.every(file => file !== h.file));
  assert.equal(h.writes[0].options.flag, "wx");
  assert.equal((await fs.readdir(h.directory)).filter(name => name.endsWith(".tmp")).length, 0);
});

test("exhausted atomic replacement preserves its original error and old file, cleans temp files, and permits a later write", async t => {
  const issue = Object.assign(new Error("The destination remains busy"), { code: "EPERM" });
  let busy = true;
  const h = await atomicFixture(t, { rename: async (from, to) => { if (busy) throw issue; return fs.rename(from, to); } });
  await fs.writeFile(h.file, "previous");
  await assert.rejects(h.writer(h.file, "newer"), error => error === issue && isRetryableAtomicReplaceError(error));
  assert.equal(h.renames.length, 9);
  assert.equal(h.waits.reduce((sum, value) => sum + value, 0), 1975);
  assert.equal(await fs.readFile(h.file, "utf8"), "previous");
  assert.equal((await fs.readdir(h.directory)).filter(name => name.endsWith(".tmp")).length, 0);
  assert.equal(isRetryableAtomicReplaceError(Object.assign(new Error("Unrelated model failure"), { code: "EPERM" })), false);
  assert.equal(isRetryableAtomicReplaceError(Object.assign(new Error("Internal wrapper"), { cause: issue })), true);
  const cycle = new Error("Untrusted cyclic cause"); cycle.cause = cycle;
  assert.equal(isRetryableAtomicReplaceError(cycle), false);
  const unsafeCause = Object.defineProperty(new Error("Untrusted getter"), "cause", { get() { throw new Error("Do not execute error getters"); } });
  assert.equal(isRetryableAtomicReplaceError(unsafeCause), false);
  busy = false;
  await h.writer(h.file, "recovered");
  assert.equal(await fs.readFile(h.file, "utf8"), "recovered");
});

test("nonbusy atomic filesystem errors fail immediately instead of retrying or replacing the prior data", async t => {
  const issue = Object.assign(new Error("Disk I/O failure"), { code: "EIO" });
  const h = await atomicFixture(t, { rename: async () => { throw issue; } });
  await fs.writeFile(h.file, "previous");
  await assert.rejects(h.writer(h.file, "newer"), error => error === issue && !isRetryableAtomicReplaceError(error));
  assert.equal(h.renames.length, 1); assert.deepEqual(h.waits, []);
  assert.equal(await fs.readFile(h.file, "utf8"), "previous");
  assert.equal((await fs.readdir(h.directory)).filter(name => name.endsWith(".tmp")).length, 0);
});

test("overlapping service persistence is ordered per file and snapshots newer records only after a blocked older write", async t => {
  let release, started;
  const blocked = new Promise(resolve => { started = resolve; });
  const h = await atomicFixture(t, { rename: async (from, to, attempt) => {
    if (attempt === 1) throw Object.assign(new Error("Temporary lock"), { code: "EPERM" });
    return fs.rename(from, to);
  }, wait: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const service = new JobResearchService({ directory: h.directory, dispatcher: { async close() {} }, writeAtomic: h.writer });
  service.records = [{ requestId: "first", state: "queued" }];
  const first = service.persist();
  await blocked;
  service.records.push({ requestId: "second", state: "queued" });
  const second = service.persist();
  service.records[0].state = "completed";
  assert.equal(h.writes.length, 1, "the second snapshot is not written while replacement is waiting");
  release(); await Promise.all([first, second]);
  assert.deepEqual(JSON.parse(await fs.readFile(h.file, "utf8")), service.records);
  assert.equal(h.writes.length, 2); assert.equal(h.renames.length, 3);
  assert.equal((await fs.readdir(h.directory)).filter(name => name.endsWith(".tmp")).length, 0);
});

test("a report updated while its replacement is busy remains pending until its newest diagnostic is written", async t => {
  let release, started;
  const blocked = new Promise(resolve => { started = resolve; });
  const h = await atomicFixture(t, { rename: async (from, to, attempt) => {
    if (attempt === 1) throw Object.assign(new Error("Temporary report lock"), { code: "EPERM" });
    return fs.rename(from, to);
  }, wait: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const service = new JobResearchService({ directory: h.directory, dispatcher: { async close() {} }, writeAtomic: h.writer });
  const record = { requestId: crypto.randomUUID(), state: "queued", createdAt: Date.now(), job };
  service.diagnosticEvent(record, "queued");
  const first = service.writeReport(record);
  await blocked;
  service.diagnosticEvent(record, "new-diagnostic", { reason: "The state changed during the busy replacement." });
  release(); assert.equal(await first, true);
  assert.equal(service.pendingReports.has(record.requestId), true);
  assert.equal(await service.writeReport(record), true);
  assert.equal(service.pendingReports.has(record.requestId), false);
  const report = JSON.parse(await fs.readFile(path.join(h.directory, "reports", `${record.requestId}.json`), "utf8"));
  assert.equal(report.events.at(-1).type, "new-diagnostic");
});

async function storageRetryFixture(t) {
  let busy = false, now = Date.now();
  const calls = [];
  const issue = Object.assign(new Error("EPERM: replacement is temporarily busy"), { code: "EPERM" });
  const h = await atomicFixture(t, { rename: async (from, to) => {
    if (busy && path.basename(to) === "requests.json") throw issue;
    return fs.rename(from, to);
  } });
  const dispatcher = {
    async resolveResearchModel() { return { model: "frozen-model", reasoningEffort: "high" }; },
    async dispatch(prompt, callbacks) {
      calls.push({ prompt, callbacks });
      await callbacks.beforeSubmit?.();
      await callbacks.onSession?.({ threadId: "storage-thread" });
      await callbacks.onSubmitted?.({ threadId: "storage-thread", turnId: "storage-turn" });
    },
    async operationStatus() { return { state: "turn_started" }; }, async close() {}
  };
  const service = new JobResearchService({ directory: h.directory, dispatcher, clock: () => now, writeAtomic: h.writer });
  const client = "a".repeat(64), id = crypto.randomUUID();
  return { ...h, service, dispatcher, calls, client, id, issue, busy(value) { busy = value; }, advance(ms) { now += ms; } };
}

test("exhausted pre-dispatch storage locks remain queued and retry the same operation only after persistence recovers", async t => {
  const h = await storageRetryFixture(t);
  const originalSubmit = h.service.submit;
  h.service.submit = () => {};
  await h.service.enqueue(h.client, h.id, job);
  h.service.submit = originalSubmit;
  const record = h.service.records[0];
  const originalIdentity = { requestId: record.requestId, captureRef: record.captureRef, fingerprint: record.fingerprint };
  h.busy(true);
  h.service.submit(record); await Promise.all(h.service.running.values());
  assert.equal(h.calls.length, 0, "a failed durable pre-dispatch write cannot start research");
  assert.equal(record.state, "queued"); assert.equal(record.retryCount, 1); assert.equal(record.retryFailed, false);
  assert.match(record.error, /EPERM/u);
  assert.equal(record.diagnostics.events.at(-1).type, "storage-retry-pending");
  assert.equal(JSON.parse(await fs.readFile(h.file, "utf8"))[0].state, "queued", "the last durable request remains intact");
  const queued = await h.service.get(h.client, h.id);
  assert.equal(queued.retryableResearch, true); assert.equal(queued.state, "queued");
  assert.equal(queued.recoverableStorageFailure, true);
  h.busy(false); h.advance(30_000);
  await Promise.all([h.service.get(h.client, h.id), h.service.get(h.client, h.id)]);
  await Promise.all(h.service.running.values());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].callbacks.operationId, `research:${h.id}:${h.client.slice(0, 16)}`);
  assert.equal(h.calls[0].callbacks.retryFailed, false);
  assert.deepEqual({ requestId: record.requestId, captureRef: record.captureRef, fingerprint: record.fingerprint }, originalIdentity);
  await h.service.get(h.client, h.id); assert.equal(h.calls.length, 1);
  assert.equal((await h.service.get(h.client, h.id)).recoverableStorageFailure, true);
  await h.service.complete(record.captureRef, skip);
  assert.equal((await h.service.get(h.client, h.id)).recoverableStorageFailure, true, "completed results keep the marker for a late client reconciliation");
  assert.equal((await fs.readdir(h.directory)).filter(name => name.endsWith(".tmp")).length, 0);
});

test("an unrelated dispatcher EPERM cannot masquerade as a retryable storage replacement", async t => {
  const h = await storageRetryFixture(t);
  h.dispatcher.dispatch = async () => { throw Object.assign(new Error("Permission denied by the model runtime"), { code: "EPERM" }); };
  await h.service.enqueue(h.client, h.id, job); await Promise.all(h.service.running.values());
  const record = h.service.records[0];
  assert.equal(record.state, "failed"); assert.equal(record.retryAt, undefined);
  assert.match(record.error, /Permission denied/u);
  assert.equal(h.service.publicResult(record).recoverableStorageFailure, undefined);
  record.recoverableStorageFailure = true;
  assert.equal(h.service.publicResult(record).recoverableStorageFailure, undefined, "a terminal model failure is not recoverable even after an earlier storage problem");
});

test("a completed callback is not exposed or authorized until its result is durably persisted and replay stays idempotent", async t => {
  const h = await storageRetryFixture(t);
  const captured = { ...job, isEasyApply: false, applyUrl: "https://example.com/jobs/987654321",
    selectedRegion: "uk", profileRoutingVersion: 1 };
  await h.service.enqueue(h.client, h.id, captured); await Promise.all(h.service.running.values());
  const record = h.service.records[0];
  const result = { decision: "save", company: job.company, title: job.title,
    role: { eligible: true, category: "software-development", evidence: "Build and maintain backend software services and automated tests." } };
  h.busy(true);
  await assert.rejects(h.service.complete(record.captureRef, result), error => error === h.issue);
  assert.equal(record.state, "completed", "retain the validated decision for a durable retry");
  assert.equal(h.service.pendingCompletions.has(record), true);
  assert.equal(record.diagnostics.events.at(-1).type, "decision-persistence-pending");
  assert.throws(() => h.service.publicResult(record), error => error.code === "RESEARCH_PERSISTENCE_PENDING" && error.status === 503);
  await assert.rejects(h.service.get(h.client, h.id), error => error === h.issue);
  const claim = { action: "acquire", destination: `applicantally-file:${crypto.randomUUID()}` };
  await assert.rejects(h.service.saveClaim(h.client, h.id, claim), error => error === h.issue);
  const durableBefore = JSON.parse(await fs.readFile(h.file, "utf8"))[0];
  assert.equal(durableBefore.state, "researching"); assert.equal(durableBefore.result, undefined);
  assert.equal(JSON.parse(await fs.readFile(h.service.saveClaimsFile, "utf8")).claims.length, 0);
  h.busy(false);
  const receipt = await h.service.complete(record.captureRef, result);
  assert.equal(receipt.replayed, true);
  assert.equal(h.service.pendingCompletions.has(record), false);
  const completed = await h.service.get(h.client, h.id);
  assert.equal(completed.state, "completed"); assert.equal(completed.result.decision, "save");
  assert.equal(JSON.parse(await fs.readFile(h.file, "utf8"))[0].result.decision, "save");
  assert.equal(h.calls.length, 1, "durable completion recovery never starts another AI dispatch");
});

test("transient desktop ledger replacement locks do not duplicate a submitted turn or change its operation identity", async t => {
  let locks = 2;
  const waits = [];
  const writer = createAtomicFileWriter({ fileSystem: { ...fs, async rename(from, to) {
    const ledger = JSON.parse(await fs.readFile(from, "utf8"));
    const operation = Object.values(ledger.operations)[0];
    if (operation?.phase === "turn_starting" && locks-- > 0) throw Object.assign(new Error("Ledger temporarily busy"), { code: "EPERM" });
    return fs.rename(from, to);
  } }, wait: async delay => { waits.push(delay); } });
  const h = await desktopFixture(t, { writeAtomic: writer });
  const submitted = await h.submit();
  assert.deepEqual(waits, [25, 50]);
  const durable = JSON.parse(await fs.readFile(h.dispatcher.ledgerPath, "utf8")).operations[h.operationId];
  assert.equal(durable.phase, "turn_started"); assert.equal(durable.turnId, submitted.turnId);
  assert.equal(durable.operationId, h.operationId);
  const recovered = await h.submit();
  assert.equal(recovered.turnId, submitted.turnId);
  assert.equal(h.requests.filter(item => item.method === "thread/start").length, 1);
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 1);
  assert.equal((await fs.readdir(h.directory)).some(name => name.endsWith(".tmp")), false);
});

test("exhausted ledger writes before turn submission preserve trusted cause and require same-thread inspection before retry", async t => {
  let busy = true;
  const issue = Object.assign(new Error("Ledger replacement remains busy"), { code: "EPERM" });
  const writer = createAtomicFileWriter({ fileSystem: { ...fs, async rename(from, to) {
    const ledger = JSON.parse(await fs.readFile(from, "utf8"));
    if (busy && Object.values(ledger.operations)[0]?.phase === "turn_starting") throw issue;
    return fs.rename(from, to);
  } }, wait: async () => {} });
  const h = await desktopFixture(t, { writeAtomic: writer });
  await assert.rejects(h.submit(), error => {
    assert.equal(error.details?.deliveryAmbiguous, false); assert.equal(error.details?.phase, "ledger_before_turn");
    assert.equal(error.cause, issue); assert.equal(isRetryableAtomicReplaceError(error), true); return true;
  });
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 0);
  assert.equal(JSON.parse(await fs.readFile(h.dispatcher.ledgerPath, "utf8")).operations[h.operationId].phase, "thread_created");
  assert.equal((await h.dispatcher.operation(h.operationId)).phase, "thread_created", "failed persistence cannot advance the cached ledger");
  busy = false;
  h.turns.push({ id: "unrelated-turn", status: "completed", clientUserMessageId: "unrelated-operation" });
  h.advance(5_000);
  await assert.rejects(h.submit(), error => error.details?.deliveryAmbiguous === true);
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 0, "a storage retry cannot submit into a task containing an unrelated turn");
  h.turns.length = 0;
  const recovered = await h.submit();
  assert.equal(recovered.threadId, "capacity-thread");
  assert.equal(h.requests.filter(item => item.method === "thread/start").length, 1);
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 1);
  assert.ok(h.requests.some(item => item.method === "thread/turns/list"));
});

test("exhausted ledger confirmation after an accepted turn remains ambiguous and restart recovers without another submission", async t => {
  let busy = true;
  const issue = Object.assign(new Error("Accepted-turn ledger replacement remains busy"), { code: "EPERM" });
  const writer = createAtomicFileWriter({ fileSystem: { ...fs, async rename(from, to) {
    const ledger = JSON.parse(await fs.readFile(from, "utf8"));
    if (busy && Object.values(ledger.operations)[0]?.phase === "turn_started") throw issue;
    return fs.rename(from, to);
  } }, wait: async () => {} });
  const h = await desktopFixture(t, { writeAtomic: writer });
  await assert.rejects(h.submit(), error => {
    assert.equal(error.details?.deliveryAmbiguous, true);
    assert.equal(error.details?.threadId, "capacity-thread"); assert.equal(error.details?.turnId, "capacity-turn-1");
    assert.equal(error.cause, issue); assert.equal(isRetryableAtomicReplaceError(error), true); return true;
  });
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 1);
  const durable = JSON.parse(await fs.readFile(h.dispatcher.ledgerPath, "utf8")).operations[h.operationId];
  assert.equal(durable.phase, "turn_starting"); assert.ok(durable.submissionAttemptedAt);
  assert.equal((await h.dispatcher.operation(h.operationId)).phase, "turn_starting");
  const restarted = h.makeDispatcher();
  await assert.rejects(restarted.dispatch("Research this exact captured job and call complete_job_capture.", { operationId: h.operationId, workflow: "research" }), error =>
    error.details?.deliveryAmbiguous === true && error.details?.turnId === "capacity-turn-1" && isRetryableAtomicReplaceError(error));
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 1, "a failed recovery ledger write cannot submit another turn");
  busy = false;
  const recovered = await restarted.dispatch("Research this exact captured job and call complete_job_capture.", { operationId: h.operationId, workflow: "research" });
  assert.equal(recovered.turnId, "capacity-turn-1"); assert.equal(recovered.threadId, "capacity-thread");
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 1);
  assert.equal(h.requests.filter(item => item.method === "thread/start").length, 1);
  assert.equal(JSON.parse(await fs.readFile(h.dispatcher.ledgerPath, "utf8")).operations[h.operationId].turnId, "capacity-turn-1");
});
