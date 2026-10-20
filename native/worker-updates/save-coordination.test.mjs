import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { JobResearchService, TRACKER_EXTENSION_ID } from "../job-research.js";

const clientA = "a".repeat(64), clientB = "b".repeat(64);
const destination = `applicantally-file:${crypto.randomUUID()}`;
const otherDestination = `applicantally-file:${crypto.randomUUID()}`;
const dispatcher = { async close() {} };
const job = company => ({ company, title: "Software Engineer", description: "Build reliable production software services.",
  sourceUrl: "https://www.linkedin.com/jobs/view/123", jobId: "123", isEasyApply: false, workplaceType: "remote" });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "save-coordination-"));
  const service = new JobResearchService({ directory, dispatcher });
  service.records = [];
  const record = (client, company = "Example Company", delta = {}) => {
    const value = { client, requestId: crypto.randomUUID(), state: "completed", createdAt: Date.now(),
      job: job(company), result: { decision: "save" }, ...delta };
    service.records.push(value); return value;
  };
  t.after(async () => { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, directory, record };
}

const acquire = (service, record, target = destination) => service.saveClaim(record.client, record.requestId, { action: "acquire", destination: target });
const settle = (service, record, token, target = destination) => service.saveClaim(record.client, record.requestId,
  { action: "settle", destination: target, token });

test("two browser clients cannot concurrently save the same normalized company", async t => {
  const h = await fixture(t);
  const first = h.record(clientA, "  Example   Company  "), second = h.record(clientB, "example company");
  const results = await Promise.all([acquire(h.service, first), acquire(h.service, second)]);
  assert.equal(results.filter(value => value.acquired).length, 1);
  assert.equal(results.find(value => !value.acquired).code, "SAVE_COORDINATION_BUSY");
  const winner = results[0].acquired ? first : second, loser = winner === first ? second : first;
  const granted = results.find(value => value.acquired);
  assert.match(granted.token, /^[a-f0-9-]{36}$/);
  await settle(h.service, winner, granted.token);
  assert.equal((await acquire(h.service, loser)).acquired, true);
});

test("different companies and destination identities proceed independently", async t => {
  const h = await fixture(t), a = h.record(clientA, "One"), b = h.record(clientB, "Two"), c = h.record(clientB, "One");
  const results = await Promise.all([acquire(h.service, a), acquire(h.service, b), acquire(h.service, c, otherDestination)]);
  assert.equal(results.every(value => value.acquired), true);
  const data = JSON.parse(await fs.readFile(h.service.saveClaimsFile, "utf8"));
  assert.equal(data.claims.length, 3);
  assert.equal(data.claims.some(claim => "job" in claim || "profile" in claim || "company" in claim || "path" in claim), false);
});

test("same-owner retries and worker restarts retain one durable token without TTL takeover", async t => {
  const h = await fixture(t), a = h.record(clientA), b = h.record(clientB);
  const claim = await acquire(h.service, a);
  assert.deepEqual(await acquire(h.service, a), claim);
  await h.service.persist();
  const restarted = new JobResearchService({ directory: h.directory, dispatcher, clock: () => Date.now() + 30 * 86400000 });
  assert.deepEqual(await acquire(restarted, a), claim);
  assert.equal((await acquire(restarted, b)).code, "SAVE_COORDINATION_BUSY");
  // Claim recovery does not depend on retaining old completed research history.
  restarted.records = [];
  assert.deepEqual(await acquire(restarted, a), claim);
  assert.deepEqual(await settle(restarted, a, claim.token), { settled: true });
  assert.equal(JSON.parse(await fs.readFile(restarted.saveClaimsFile, "utf8")).claims.length, 0);
});

test("wrong client, token, request or destination cannot release another browser's claim", async t => {
  const h = await fixture(t), a = h.record(clientA), b = h.record(clientB), claim = await acquire(h.service, a);
  await settle(h.service, b, claim.token);
  await settle(h.service, a, crypto.randomUUID());
  await settle(h.service, a, claim.token, otherDestination);
  await h.service.saveClaim(clientA, crypto.randomUUID(), { action: "settle", destination, token: claim.token });
  assert.deepEqual(await acquire(h.service, a), claim);
  assert.equal((await acquire(h.service, b)).acquired, false);
});

test("a stale acknowledgment never clears a new owner's claim", async t => {
  const h = await fixture(t), a = h.record(clientA), b = h.record(clientB), first = await acquire(h.service, a);
  await settle(h.service, a, first.token);
  const second = await acquire(h.service, b);
  assert.equal(second.acquired, true);
  await settle(h.service, a, first.token);
  assert.deepEqual(await acquire(h.service, b), second);
  assert.equal((await acquire(h.service, a)).acquired, false);
});

test("pending, skipped, excluded, invalid-source and foreign research cannot acquire ownership", async t => {
  const h = await fixture(t);
  for (const delta of [{ state: "researching" }, { state: "failed" }, { result: { decision: "skip" } },
    { job: { ...job("Excluded"), title: "Staff Software Engineer" } },
    { job: { ...job("Invalid source"), sourceUrl: "https://jobright.ai.evil.example/jobs/recommend" } }]) {
    const record = h.record(clientA, "No save", delta);
    await assert.rejects(acquire(h.service, record), error => error.status === 409);
  }
  const record = h.record(clientA);
  await assert.rejects(h.service.saveClaim(clientB, record.requestId, { action: "acquire", destination }), error => error.status === 404);
});

test("missing or malformed initialized storage fails closed and never resets ownership", async t => {
  const h = await fixture(t), a = h.record(clientA), b = h.record(clientB);
  await acquire(h.service, a);
  const original = await fs.readFile(h.service.saveClaimsFile, "utf8");
  await fs.unlink(h.service.saveClaimsFile);
  const restarted = new JobResearchService({ directory: h.directory, dispatcher }); restarted.records = h.service.records;
  await assert.rejects(acquire(restarted, b), error => error.status === 503);
  await fs.writeFile(h.service.saveClaimsFile, "{broken");
  await assert.rejects(acquire(restarted, b), error => error.status === 503);
  await fs.writeFile(h.service.saveClaimsFile, JSON.stringify({ version: 1, claims: [{ key: "invalid" }] }));
  await assert.rejects(acquire(restarted, b), error => error.status === 503);
  await fs.writeFile(h.service.saveClaimsFile, original);
  assert.equal((await acquire(restarted, b)).acquired, false);
});

test("save coordination rejects arbitrary paths, invalid identities and extra input fields", async t => {
  const h = await fixture(t), record = h.record(clientA);
  for (const value of [null, [], { action: "delete", destination }, { action: "acquire", destination: "C:\\private" },
    { action: "acquire", destination, company: "Override" }, { action: "settle", destination },
    { action: "settle", destination, token: "bad" }]) {
    await assert.rejects(h.service.saveClaim(clientA, record.requestId, value), error => error.status === 400);
  }
  await assert.rejects(h.service.saveClaim("unknown", record.requestId, { action: "acquire", destination }), error => error.status === 400);
});

test("HTTP save claims retain fixed extension/client authentication and JSON boundaries", async t => {
  const h = await fixture(t), secret = "c".repeat(64), client = crypto.createHash("sha256").update(secret).digest("hex");
  const record = h.record(client);
  const request = async (headers = {}, body = { action: "acquire", destination }) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = "POST";
    req.headers = { host: "127.0.0.1:8787", origin: `chrome-extension://${TRACKER_EXTENSION_ID}`,
      "x-job-tracker-extension": TRACKER_EXTENSION_ID, "x-job-tracker-client": secret, "content-type": "application/json", ...headers };
    const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    const handled = await h.service.handleHttp(req, res, new URL(`http://127.0.0.1:8787/job-research/${record.requestId}/save-claim`));
    return { ...res, handled };
  };
  assert.equal((await request({ origin: "https://jobright.ai" })).status, 403);
  assert.equal((await request({ "x-job-tracker-client": "" })).status, 403);
  assert.equal((await request({ "content-type": "text/plain" })).status, 415);
  const response = await request(); assert.equal(response.handled, true); assert.equal(response.status, 200); assert.equal(response.body.acquired, true);
  const released = await request({}, { action: "settle", destination, token: response.body.token });
  assert.deepEqual(released.body, { settled: true });
});
