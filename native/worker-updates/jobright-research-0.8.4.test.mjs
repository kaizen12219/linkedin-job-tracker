import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import CapturePolicy from "../lib/capture-policy.cjs";
import ProfileRouting from "../lib/profile-routing.cjs";
import { JobResearchService, buildResearchPrompt, verifyApplicationUrl, registerJobCaptureTool } from "../job-research.js";

const id = "68f713ae1a23456789abcdef";
const sourceUrl = `https://jobright.ai/jobs/info/${id}`;
const duties = "Independently design and build production software services and maintain reliable automated tests.";
const years = "At least 6 years of professional software engineering experience is required.";
const job = { company: "Jobright Test Employer", title: "Senior Software Engineer", description: `${duties} ${years}`,
  sourceUrl, applyUrl: "https://careers.employer.com/jobs/123", jobId: id, isEasyApply: true, workplaceType: "remote",
  selectedRegion: "us", selectedRegionSource: "search-control", profileRoutingVersion: 1 };
const findings = { decision: "save", company: job.company, title: job.title,
  role: { eligible: true, category: "software-development", evidence: duties },
  experience: { minimumYears: 6, scope: "senior", evidence: years },
  application: { url: job.applyUrl, company: job.company, title: job.title, applicationsOpen: true, free: true,
    evidence: "An open free application form was observed for this exact vacancy." } };
const settle = service => Promise.all(service.running.values());

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jobright-research-"));
  const calls = [];
  const dispatcher = { async resolveResearchModel() { return { model: "test-model", reasoningEffort: "high" }; },
    async dispatch(prompt, callbacks) { calls.push({ prompt, callbacks }); await callbacks.onSession({ threadId: "test-thread" });
      await callbacks.onSubmitted({ threadId: "test-thread", turnId: "test-turn" }); },
    async operationStatus() { return { state: "turn_started" }; }, async close() {} };
  const checkedUrls = [];
  const service = new JobResearchService({ directory, dispatcher, verifyUrl: async url => { checkedUrls.push(url); return url; } });
  t.after(async () => { await settle(service); await service.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, service, calls, checkedUrls, client: "jobright-test-client", requestId: crypto.randomUUID() };
}

test("Jobright US research applies the same quoted six-year requirements and profile routing as LinkedIn", async t => {
  const h = await fixture(t);
  await h.service.enqueue(h.client, h.requestId, job); await settle(h.service);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].prompt, /For this US capture/); assert.match(h.calls[0].prompt, /LOWER bound/);
  const ref = h.service.records[0].captureRef;
  await assert.rejects(h.service.complete(ref, { ...findings, experience: undefined }), /US result lacks verified experience/);
  await h.service.complete(ref, findings);
  const response = await h.service.get(h.client, h.requestId);
  assert.equal(response.state, "completed"); assert.equal(response.result.decision, "save");
  const choice = ProfileRouting.choose(job, { version: 1, region: "us", profiles: { kevin: "kevin-profile", jagjeet: "jagjeet-profile" } }, response.result.experience);
  assert.equal(choice.profile, "kevin-profile");
  const report = JSON.parse(await fs.readFile(path.join(h.directory, "reports", `${h.requestId}.json`), "utf8"));
  assert.equal(report.job.sourceUrl, sourceUrl); assert.equal(report.result.experience.minimumYears, 6);
});

test("Jobright skips retain exact AI reasons and all existing level exclusions", async t => {
  const h = await fixture(t);
  await h.service.enqueue(h.client, h.requestId, job); await settle(h.service);
  const reason = "The job's main duties are systems support rather than software engineering.";
  await h.service.complete(h.service.records[0].captureRef, { decision: "skip", company: job.company, title: job.title, reason });
  assert.equal((await h.service.get(h.client, h.requestId)).result.reason, reason);
  h.calls.length = 0;
  for (const title of ["Associate Software Engineer", "Technical Lead", "Staff Software Engineer"]) {
    const response = await h.service.enqueue(h.client, crypto.randomUUID(), { ...job, title });
    assert.equal(response.state, "completed"); assert.equal(response.result.decision, "skip");
  }
  await settle(h.service); assert.equal(h.calls.length, 0);
});

test("Jobright normalization rejects forged or mismatched sources and accepts verified recommend captures", async t => {
  const h = await fixture(t);
  for (const delta of [{ sourceUrl: "https://jobright.ai.evil.com/jobs/recommend" }, { sourceUrl: "https://jobright.ai/profile" },
    { sourceUrl: "http://jobright.ai/jobs/recommend" }, { sourceUrl: "https://user@jobright.ai/jobs/recommend" },
    { sourceUrl: "https://jobright.ai:8787/jobs/recommend" }, { sourceUrl: `https://jobright.ai/jobs/info/${id.toUpperCase()}` },
    { jobId: "123" }, { jobId: "" }, { jobId: "68f713ae1a23456789abcdea" }, { sourceSite: "linkedin" }]) {
    await assert.rejects(h.service.enqueue(h.client, crypto.randomUUID(), { ...job, ...delta }), error => error.status === 400, JSON.stringify(delta));
  }
  assert.equal(h.service.records.length, 0); assert.equal(h.calls.length, 0);
  await h.service.enqueue(h.client, h.requestId, { ...job, sourceUrl: "https://jobright.ai/jobs/recommend", sourceSite: "jobright" });
  await settle(h.service); assert.equal(h.calls.length, 1);
});

test("Jobright research requires the committed US search country and researches portal references", async t => {
  const h = await fixture(t);
  for (const delta of [{ selectedRegion: "" }, { selectedRegion: undefined }, { selectedRegion: "uk" }, { selectedRegion: "latam" },
    { selectedRegionSource: "" }, { selectedRegionSource: undefined }, { selectedRegionSource: "url" }, { selectedRegionSource: "search-input" }])
    await assert.rejects(h.service.enqueue(h.client, crypto.randomUUID(), { ...job, ...delta }), /Select United States/);
  assert.equal(h.calls.length, 0); assert.equal(h.service.records.length, 0);
  await h.service.enqueue(h.client, h.requestId, { ...job, applyUrl: sourceUrl, isEasyApply: false, profileRoutingVersion: undefined }); await settle(h.service);
  assert.equal(h.service.records[0].job.isEasyApply, true);
  assert.equal(h.service.records[0].job.profileRoutingVersion, ProfileRouting.VERSION);
  assert.match(h.calls[0].prompt, /"isEasyApply": true/);
  await assert.rejects(h.service.complete(h.service.records[0].captureRef, { ...findings, experience: undefined }), /US result lacks verified experience/);
  await assert.rejects(h.service.complete(h.service.records[0].captureRef, { ...findings, application: undefined }), /lacks qualifying/);
  await h.service.complete(h.service.records[0].captureRef, findings);
  assert.equal((await h.service.get(h.client, h.requestId)).result.decision, "save");
});

test("ordinary external Jobright posts and LinkedIn Apply captures share the same role and experience path", async t => {
  for (const site of ["jobright", "linkedin"]) await t.test(site, async t => {
    const h = await fixture(t);
    const target = { ...job, isEasyApply: false, ...(site === "linkedin" ? {
      sourceUrl: "https://www.linkedin.com/jobs/view/123", jobId: "123"
    } : {}) };
    await h.service.enqueue(h.client, h.requestId, target); await settle(h.service);
    const record = h.service.records[0];
    assert.equal(record.job.isEasyApply, false);
    assert.match(h.calls[0].prompt, /"isEasyApply": false/);
    assert.equal(record.job.applyUrl, target.applyUrl);
    const noResearchRoute = { ...findings, application: undefined, emails: undefined };
    await h.service.complete(record.captureRef, noResearchRoute);
    const response = await h.service.get(h.client, h.requestId);
    assert.equal(response.result.decision, "save");
    const saved = CapturePolicy.verifiedJob(record.job, response.result);
    assert.equal(saved.applyUrl, target.applyUrl);
    assert.deepEqual(h.checkedUrls, [], "an ordinary external Apply capture does not require an extra application lookup");
    assert.equal(ProfileRouting.choose(target, { version: 1, region: "us", profiles: { kevin: "kevin-profile", jagjeet: "jagjeet-profile" } }, response.result.experience).profile, "kevin-profile");
  });
});

test("a false direct-apply flag cannot bypass application research without a public external URL", async t => {
  for (const applyUrl of [undefined, "", sourceUrl, "https://jobright.ai/agent", "https://www.linkedin.com/jobs/view/123",
    "http://careers.employer.com/jobs/123", "https://localhost/jobs/123", "https://user:password@careers.employer.com/jobs/123",
    `https://careers.employer.com/go?url=${encodeURIComponent(sourceUrl)}`]) await t.test(String(applyUrl), async t => {
      const h = await fixture(t);
      await h.service.enqueue(h.client, h.requestId, { ...job, applyUrl, isEasyApply: false }); await settle(h.service);
      const record = h.service.records[0];
      assert.equal(record.job.isEasyApply, true);
      assert.match(h.calls[0].prompt, /"isEasyApply": true/);
      await assert.rejects(h.service.complete(record.captureRef, { ...findings, application: undefined }), /lacks qualifying/);
      assert.equal((await h.service.get(h.client, h.requestId)).state, "researching");
    });
});

test("an explicit research flag still researches an external URL", async t => {
  const h = await fixture(t);
  await h.service.enqueue(h.client, h.requestId, job); await settle(h.service);
  assert.equal(h.service.records[0].job.isEasyApply, true);
  await assert.rejects(h.service.complete(h.service.records[0].captureRef, { ...findings, application: undefined }), /lacks qualifying/);
});

test("engineering work quoted from qualifications qualifies without matching candidate skills", async t => {
  const h = await fixture(t);
  const work = "Experience building reliable data infrastructure and designing ETL pipelines that move data between production systems.";
  const target = { ...job, title: "Data Engineer", description: `Required Qualifications\n${work}\n${years}`, isEasyApply: false };
  await h.service.enqueue(h.client, h.requestId, target); await settle(h.service);
  const record = h.service.records[0];
  const result = { ...findings, title: target.title, application: undefined,
    role: { eligible: true, category: "data-ai-engineering", evidence: work } };
  await h.service.complete(record.captureRef, result);
  assert.equal((await h.service.get(h.client, h.requestId)).result.decision, "save");
  assert.match(h.calls[0].prompt, /Required or Qualifications text describing building/);
  assert.match(h.calls[0].prompt, /a separate Responsibilities section is not required/);
  assert.match(h.calls[0].prompt, /generic list of tools or skills alone remains insufficient/);
  assert.match(h.calls[0].prompt, /Do not compare the listed skills with candidate profiles/);
  assert.doesNotMatch(h.calls[0].prompt, /not a title, skills list or invented paraphrase/);
  let tool;
  registerJobCaptureTool({ registerTool(name, definition) { assert.equal(name, "complete_job_capture"); tool = definition; } }, h.service, z);
  assert.match(tool.description, /Engineering work described under Required or Qualifications counts/);
  assert.match(tool.description, /Generic tool\/skill keywords alone never approve jobs/);
  assert.match(tool.description, /Do not compare listed skills with candidate profiles/);
});

test("Jobright portal URLs and redirect wrappers never qualify as verified external application routes", async t => {
  const h = await fixture(t);
  const target = { ...job, isEasyApply: true, applyUrl: sourceUrl };
  await h.service.enqueue(h.client, h.requestId, target); await settle(h.service);
  const application = { url: sourceUrl, company: job.company, title: job.title, applicationsOpen: true, free: true,
    evidence: "An open free application form was observed for this exact vacancy." };
  for (const url of [sourceUrl, "https://jobright.ai/agent", `https://careers.employer.com/go?url=${encodeURIComponent(sourceUrl)}`]) {
    await assert.rejects(h.service.complete(h.service.records[0].captureRef, { ...findings, application: { ...application, url } }), /lacks qualifying/);
  }
  const external = { ...application, url: job.applyUrl };
  await h.service.complete(h.service.records[0].captureRef, { ...findings, application: external });
  const saved = CapturePolicy.verifiedJob(target, (await h.service.get(h.client, h.requestId)).result);
  assert.equal(saved.applyUrl, external.url); assert.equal(saved.info, `Jobright job: ${sourceUrl}`);
  await assert.rejects(verifyApplicationUrl(job.applyUrl, { getPage: async () => ({ status: 302, location: sourceUrl }) }), /Jobright/);
});

test("LinkedIn replays retain their original normalized job fingerprint and completed findings", async t => {
  const h = await fixture(t);
  const linkedIn = { ...job, sourceUrl: "https://www.linkedin.com/jobs/view/123", jobId: "123", isEasyApply: false };
  await h.service.enqueue(h.client, h.requestId, linkedIn); await settle(h.service);
  const record = h.service.records[0]; const fingerprint = record.fingerprint;
  assert.equal(Object.hasOwn(record.job, "sourceSite"), false);
  assert.equal(record.job.isEasyApply, false);
  await h.service.complete(record.captureRef, findings);
  const replay = await h.service.enqueue(h.client, h.requestId, linkedIn);
  assert.equal(record.fingerprint, fingerprint); assert.equal(replay.result.decision, "save");
  assert.equal(h.calls.length, 1);
});

test("the research prompt excludes both portals and preserves the user's full US and seniority rules", () => {
  const prompt = buildResearchPrompt({ job, captureRef: "a".repeat(64) });
  assert.match(prompt, /exclude all LinkedIn and Jobright URLs, wrappers redirecting to either portal/);
  assert.match(prompt, /original Jobright job URL/);
  assert.match(prompt, /SENIORITY FLOOR/); assert.match(prompt, /LEAD ROLE EXCLUSION/); assert.match(prompt, /SENIORITY CEILING/);
  assert.match(prompt, /explicit 5\+ required years/i); assert.match(prompt, /Do not infer citizenship/);
  assert.match(prompt, /UNTRUSTED source material/);
});
