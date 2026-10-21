import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { JobResearchService } from "../job-research.js";
import { DesktopCodexDispatcher } from "../lib/tracker-desktop-dispatcher.mjs";

const job = {
  company: "Retry Test Company", title: "Software Engineer",
  description: "Build and maintain backend software services and automated tests. This role is fully remote.",
  workplaceType: "remote", isEasyApply: true, sourceUrl: "https://www.linkedin.com/jobs/view/987654321",
  applyUrl: "https://www.linkedin.com/jobs/view/987654321", jobId: "987654321",
  selectedRegion: "us", selectedRegionSource: "search-control", profileRoutingVersion: 1
};
const skip = { decision: "skip", company: job.company, title: job.title, reason: "No verified active application route." };
async function desktopFixture(t, { writeAtomic, operationId = "research-capacity-retry-123", threadId = "capacity-thread",
  turnId = number => `capacity-turn-${number}` } = {}) {
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
      if (method === "thread/start") return { thread: { id: threadId, turns: [] }, model: params.model, reasoningEffort: params.config.model_reasoning_effort };
      if (["thread/resume", "thread/read"].includes(method)) return { thread: { id: threadId, turns: structuredClone(turns) } };
      if (method === "thread/turns/list") return { data: structuredClone(turns) };
      if (method === "turn/start") {
        const turn = { id: turnId(turns.length + 1), status: "inProgress", clientUserMessageId: params.clientUserMessageId };
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
  const options = { operationId, workflow: "research", title: "Research capacity regression" };
  const submit = extra => dispatcher.dispatch("Research this exact captured job and call complete_job_capture.", { ...options, ...extra });
  const failTurn = async (message = "Selected model is at capacity.") => {
    const turn = turns.at(-1); turn.status = "failed"; turn.error = { message };
    await assert.rejects(dispatcher.completeTurn(client, operationId, await dispatcher.operation(operationId), turn));
    return turn;
  };
  return { directory, dispatcher, makeDispatcher, client, requests, turns, operationId, submit, failTurn, clock: () => now, advance(ms) { now += ms; } };
}
async function interruptedFixture(t) {
  const requestId = crypto.randomUUID(), client = "d".repeat(64), threadId = crypto.randomUUID();
  const h = await desktopFixture(t, { operationId: `research:${requestId}:${client.slice(0, 16)}`, threadId, turnId: () => crypto.randomUUID() });
  const makeService = options => new JobResearchService({ directory: h.directory, dispatcher: h.dispatcher, clock: h.clock, ...options });
  const service = makeService();
  await service.enqueue(client, requestId, job); await Promise.all(service.running.values());
  const old = structuredClone(h.turns[0]);
  h.turns[0].status = "interrupted";
  await h.dispatcher.completeTurn(h.client, h.operationId, await h.dispatcher.operation(h.operationId), h.turns[0]).catch(() => {});
  await service.get(client, requestId);
  assert.equal(service.records[0].state, "failed");
  const approval = { requestId, threadId, turnId: old.id, approvalId: crypto.randomUUID(), approvedAt: new Date(h.clock()).toISOString() };
  const manifest = async (values = [approval]) => fs.writeFile(service.interruptedRecoveriesFile, JSON.stringify({ version: 1, approvals: values }));
  return { ...h, requestId, scopedClient: client, service, makeService, approval, manifest, old };
}

test("operator recovery starts one fresh turn in the same thread and preserves the exact original request and model", async t => {
  const h = await interruptedFixture(t), original = structuredClone(h.service.records[0]);
  const unrelated = { ...structuredClone(original), requestId: crypto.randomUUID() };
  h.service.records.push(unrelated); await h.service.persist();
  await h.manifest();
  const restarted = h.makeService(); await restarted.start(); await Promise.all(restarted.running.values());
  const record = restarted.records.find(item => item.requestId === h.requestId);
  for (const key of ["requestId", "client", "captureRef", "fingerprint", "createdAt", "model", "reasoningEffort", "job"])
    assert.deepEqual(record[key], original[key], key);
  assert.equal(record.threadId, original.threadId); assert.notEqual(record.turnId, original.turnId);
  assert.equal(record.recoverableResearchFailure, true);
  assert.equal(restarted.publicResult(record).recoverableResearchFailure, true);
  assert.equal(restarted.records.find(item => item.requestId === unrelated.requestId).state, "failed", "an unrequested interrupted job stays terminal");
  assert.equal(h.requests.filter(item => item.method === "thread/start").length, 1);
  const starts = h.requests.filter(item => item.method === "turn/start");
  assert.equal(starts.length, 2); assert.notEqual(starts[0].params.clientUserMessageId, starts[1].params.clientUserMessageId);
  assert.match(starts[1].params.clientUserMessageId, new RegExp(h.approval.approvalId));
  const ledger = await h.dispatcher.operation(h.operationId);
  assert.deepEqual(ledger.previousInterruptedTurnIds, [h.approval.turnId]);
  assert.equal(ledger.interruptedRecovery.approvalId, h.approval.approvalId);
  assert.equal((await h.dispatcher.completeTurn(h.client, h.operationId, ledger, { ...h.old, status: "completed" })).deliveryState, "superseded");
  assert.equal((await h.dispatcher.operation(h.operationId)).turnId, record.turnId);
  await assert.rejects(fs.stat(restarted.interruptedRecoveriesFile), error => error.code === "ENOENT");
  h.turns.at(-1).status = "interrupted";
  await h.dispatcher.completeTurn(h.client, h.operationId, await h.dispatcher.operation(h.operationId), h.turns.at(-1)).catch(() => {});
  await assert.rejects(h.submit({ retryFailed: true }), error => error.code === "CHATGPT_DESKTOP_TURN_FAILED");
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 2, "the approval cannot authorize a later interrupted turn");
});

test("a replayed approval cannot reset an active or completed recovered request or create another turn", async t => {
  const h = await interruptedFixture(t); await h.manifest();
  const first = h.makeService(); await first.start(); await Promise.all(first.running.values());
  const record = first.records[0];
  await h.manifest([Object.fromEntries(Object.entries(h.approval).reverse())]);
  const activeReplay = h.makeService(); await activeReplay.start(); await Promise.all(activeReplay.running.values());
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 2);
  await activeReplay.complete(record.captureRef, skip);
  await h.manifest();
  const completedReplay = h.makeService(); await completedReplay.start(); await Promise.all(completedReplay.running.values());
  assert.equal(completedReplay.records[0].state, "completed");
  assert.equal(completedReplay.publicResult(completedReplay.records[0]).recoverableResearchFailure, true);
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 2);
});

test("interrupted tasks without an explicit approval remain terminal even when retryFailed is requested", async t => {
  const h = await interruptedFixture(t);
  await assert.rejects(h.submit({ retryFailed: true }), error => error.code === "CHATGPT_DESKTOP_TURN_FAILED");
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 1);
  const restarted = h.makeService(); await restarted.start(); await Promise.all(restarted.running.values());
  assert.equal(restarted.records[0].state, "failed");
  assert.equal(restarted.publicResult(restarted.records[0]).recoverableResearchFailure, undefined);
});

test("operator approval refuses completed callbacks, cancellation markers, changed identities and save ownership", async t => {
  for (const obstruction of ["completed", "callback", "cancelled", "identity", "save-claim", "active-ledger"]) {
    const h = await interruptedFixture(t), record = h.service.records[0];
    if (obstruction === "completed") { record.state = "completed"; record.result = skip; }
    if (obstruction === "callback") h.service.diagnosticEvent(record, "decision-accepted");
    if (obstruction === "identity") record.turnId = crypto.randomUUID();
    if (obstruction === "cancelled") await h.dispatcher.updateOperation(h.operationId, { terminationRequestedAt: new Date(h.clock()).toISOString() });
    if (obstruction === "active-ledger") await h.dispatcher.updateOperation(h.operationId, { phase: "turn_started", turnStatus: null });
    if (obstruction === "save-claim") {
      await h.service.loadSaveClaims();
      await h.service.persistSaveClaims([{ key: "a".repeat(64), client: h.scopedClient, requestId: h.requestId,
        destination: `applicantally-file:${crypto.randomUUID()}`, token: crypto.randomUUID(), createdAt: h.clock() }]);
    }
    await h.service.persist(); await h.manifest();
    const restarted = h.makeService(); await assert.rejects(restarted.start(), undefined, obstruction);
    assert.equal(h.requests.filter(item => item.method === "turn/start").length, 1, obstruction);
    assert.equal(restarted.records[0].interruptedRecovery, undefined, obstruction);
  }
});

test("an approved recovery still refuses a now-active, completed or unrelated turn in the live task history", async t => {
  for (const obstruction of ["active", "completed", "unrelated"]) {
    const h = await interruptedFixture(t); await h.manifest();
    if (obstruction === "active") h.turns[0].status = "inProgress";
    if (obstruction === "completed") h.turns[0].status = "completed";
    if (obstruction === "unrelated") h.turns.push({ id: crypto.randomUUID(), status: "completed", clientUserMessageId: "another-operation" });
    const restarted = h.makeService(); await restarted.start(); await Promise.all(restarted.running.values());
    assert.equal(h.requests.filter(item => item.method === "turn/start").length, 1, obstruction);
    assert.equal((await h.dispatcher.operation(h.operationId)).interruptedRecoveryUsedAt, undefined, obstruction);
  }
});

test("startup recovers an approved ledger after a failed request commit without losing proof or duplicating submission", async t => {
  const h = await interruptedFixture(t); await h.manifest();
  const failed = h.makeService({ writeAtomic: async (file, contents) => {
    const data = typeof contents === "function" ? contents() : contents;
    if (file.endsWith("requests.json") && JSON.parse(data).some(record => record.interruptedRecovery)) throw Object.assign(new Error("Disk write failed"), { code: "EIO" });
    return fs.writeFile(file, data);
  } });
  await assert.rejects(failed.start(), /Disk write failed/u);
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 1);
  assert.equal(JSON.parse(await fs.readFile(h.service.file, "utf8"))[0].state, "failed");
  assert.equal((await h.dispatcher.operation(h.operationId)).interruptedRecovery.approvalId, h.approval.approvalId);
  const restarted = h.makeService(); await restarted.start(); await Promise.all(restarted.running.values());
  assert.equal(h.requests.filter(item => item.method === "turn/start").length, 2);
  assert.equal(restarted.records[0].requestId, h.requestId);
});
