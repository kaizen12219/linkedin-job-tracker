const assert = require("node:assert/strict");
const test = require("node:test");
const policy = require("../src/capture-policy.js");
const collector = require("../src/job-collector.js");
const id = "68f713ae1a23456789abcdef";
const otherId = "68f713ae1a23456789abcdea";
const detail = `https://jobright.ai/jobs/info/${id}`;

test("source pages require supported HTTPS portal routes and reject account/agent pages and deceptive hosts", () => {
  for (const url of [detail, `${detail}/?from=recommend`, "https://jobright.ai/jobs/recommend", "https://www.jobright.ai/jobs/recommend/"])
    assert.equal(policy.sourceSite(url), "jobright", url);
  for (const url of ["https://www.linkedin.com/jobs/view/123", "https://uk.linkedin.com/jobs/search/?currentJobId=123"])
    assert.equal(policy.sourceSite(url), "linkedin", url);
  for (const url of ["http://jobright.ai/jobs/recommend", "https://jobright.ai:8787/jobs/recommend", "https://user:pass@jobright.ai/jobs/recommend",
    "https://eviljobright.ai/jobs/recommend", "https://jobright.ai.evil.com/jobs/recommend", "https://sub.jobright.ai/jobs/recommend",
    "https://jobright.ai/profile", "https://jobright.ai/resume", "https://jobright.ai/agent", "https://jobright.ai/jobs/liked", "https://jobright.ai/jobs/applied",
    "https://jobright.ai/jobs/info/not-an-id", `https://jobright.ai/jobs/info/${id.toUpperCase()}`, `${detail}/apply`,
    "https://www.linkedin.com/in/example", "http://www.linkedin.com/jobs/view/123", "https://www.linkedin.com:8787/jobs/view/123",
    "https://person@www.linkedin.com/jobs/view/123", "https://linkedin.com.evil.com/jobs/view/123"])
    assert.equal(policy.supportedJobPage(url), false, url);
});

test("IDs are provider-specific and detail pages must identify the captured job", () => {
  assert.equal(policy.jobIdFromUrl(detail), id);
  assert.equal(policy.jobIdFromUrl(`https://jobright.ai/jobs/recommend?jobId=${id}&currentJobId=${id}`), "");
  assert.equal(policy.validJobId(id, detail), true);
  assert.equal(policy.validJobId(otherId, detail), false);
  assert.equal(policy.validJobId(id, "https://jobright.ai/jobs/recommend"), true);
  for (const invalid of ["123", id.toUpperCase(), "", 123, `${id}a`]) assert.equal(policy.validJobId(invalid, detail), false);
  assert.equal(policy.validJobId("123", "https://www.linkedin.com/jobs/search/?currentJobId=123"), true);
  assert.equal(policy.validJobId("456", "https://www.linkedin.com/jobs/search/?currentJobId=123"), false);
  assert.equal(policy.validJobId(id, "https://www.linkedin.com/jobs/view/123"), false);
  assert.equal(policy.jobIdFromUrl("https://www.linkedin.com/jobs/view/123/?trackingId=test"), "123");
  assert.equal(policy.validJobId("456", "https://www.linkedin.com/jobs/view/123"), false);
  assert.equal(policy.validJobId("123", "https://www.linkedin.com/jobs/view/not-an-id"), false);
  assert.equal(policy.validJobId("123", "https://www.linkedin.com/jobs/search/?currentJobId=123&currentJobId=456"), false);
  assert.equal(policy.validJobId(id, "https://jobright.ai/profile"), false);
});

test("Jobright detail transitions retain the committed search key and LinkedIn keys are unchanged", () => {
  assert.equal(policy.sourceSearchKey(detail), "https://jobright.ai/jobs/recommend");
  assert.equal(policy.sourceSearchKey(`${detail}?work=remote&location=US#description`), "https://jobright.ai/jobs/recommend?location=US&work=remote");
  assert.equal(policy.sourceSearchKey("https://www.jobright.ai/jobs/recommend/?work=remote&location=US"), "https://jobright.ai/jobs/recommend?location=US&work=remote");
  for (const url of ["https://www.linkedin.com/jobs/search/?keywords=engineer&currentJobId=123&start=25&geoId=103644278#job",
    "https://uk.linkedin.com/jobs/search-results/?trackingId=test&f_WT=2&keywords=engineer&refId=abc"])
    assert.equal(policy.sourceSearchKey(url), collector.searchKey(url));
  assert.equal(policy.sourceSearchKey("https://jobright.ai/profile"), "");
  assert.equal(policy.sourceSearchKey("https://linkedin.com/jobs/view/123"), "");
});

test("Jobright homepage attribution and selected-job parameters do not change search identity", () => {
  const canonical = "https://jobright.ai/jobs/recommend?location=US&work=remote";
  for (const url of [
    "https://jobright.ai/jobs/recommend?from=homepage&id=",
    `https://jobright.ai/jobs/recommend?from=homepage&id=${id}&from=recommend&id=${otherId}`,
    `${detail}?from=recommend&id=${id}`
  ]) assert.equal(policy.sourceSearchKey(url), "https://jobright.ai/jobs/recommend", url);
  for (const url of [
    `https://www.jobright.ai/jobs/recommend/?from=homepage&id=${id}&work=remote&location=US`,
    `${detail}?id=${otherId}&location=US&from=recommend&work=remote`
  ]) assert.equal(policy.sourceSearchKey(url), canonical, url);
  assert.notEqual(policy.sourceSearchKey(`${detail}?location=UK&work=remote`), canonical);
  assert.notEqual(policy.sourceSearchKey(`${detail}?location=US&work=hybrid`), canonical);
  assert.equal(policy.sourceSearchKey(`${detail}?customFilter=kept&from=homepage&id=`),
    "https://jobright.ai/jobs/recommend?customFilter=kept");
  assert.equal(policy.sourceSearchKey("https://www.linkedin.com/jobs/search/?from=homepage&id=123"),
    "https://www.linkedin.com/jobs/search/?from=homepage&id=123");
});

test("public application routes exclude both portals and three levels of encoded or nested redirect wrappers", () => {
  for (const portal of [detail, "https://jobright.ai/profile", "https://app.jobright.ai/agent", "https://www.linkedin.com/jobs/view/123",
    "https://jobright.ai./jobs/recommend", "https://www.linkedin.com./jobs/view/123"])
    assert.equal(policy.publicUrl(portal), "", portal);
  for (const portal of [detail, "https://www.linkedin.com/jobs/view/123"]) {
    let encoded = portal;
    let nested = portal;
    for (let depth = 1; depth <= 3; depth++) {
      encoded = encodeURIComponent(encoded);
      assert.equal(policy.publicUrl(`https://careers.employer.com/go?url=${encoded}`), "", `${depth} encodings`);
      nested = `https://careers.employer.com/go?url=${encodeURIComponent(nested)}`;
      assert.equal(policy.publicUrl(nested), "", `${depth} wrappers`);
    }
  }
  assert.equal(policy.publicUrl("https://careers.employer.com/jobs/123?source=jobright.ai"), "https://careers.employer.com/jobs/123?source=jobright.ai");
  assert.equal(policy.linkedInUrl("http://uk.linkedin.com/in/person"), true); // Legacy API still identifies the host.
});

test("a verified external application preserves Jobright provenance without accepting portal contact evidence", () => {
  const duties = "Independently build software services and maintain their automated tests.";
  const job = { company: "Source Test", title: "Senior Software Engineer", description: duties,
    sourceUrl: detail, applyUrl: detail, jobId: id, workplaceType: "remote", isEasyApply: true };
  const application = { url: "https://careers.employer.com/jobs/123", company: job.company, title: job.title,
    applicationsOpen: true, free: true, evidence: "The exact vacancy has an active free application form." };
  const findings = { decision: "save", company: job.company, title: job.title,
    role: { eligible: true, category: "software-development", evidence: duties }, application };
  const saved = policy.verifiedJob(job, findings);
  assert.equal(saved.applyUrl, application.url);
  assert.equal(saved.info, `Jobright job: ${detail}`);
  assert.equal(policy.verifiedJob({ ...job, info: `Jobright job: ${detail}` }, findings).info, `Jobright job: ${detail}`);
  assert.equal(policy.verifiedJob(job, { ...findings, application: { ...application, url: detail } }), null);
  assert.equal(policy.verifiedJob(job, { ...findings, application: undefined, emails: [{ email: "hiring@employer.com", kind: "application",
    company: job.company, source: "public", sourceUrl: detail, sourceQuote: "Apply at hiring@employer.com" }] }), null);
});
