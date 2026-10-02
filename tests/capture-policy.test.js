const assert = require("node:assert/strict");
const test = require("node:test");
const policy = require("../src/capture-policy.js");
const duties = "Develop and maintain software services and automated tests.";
const role = { eligible: true, category: "software-development", evidence: duties };
const job = { company: "Mews", title: "Product Builder - Fintech", description: `${duties} This role offers fully remote work. Apply by email to hiring@mews.com.`,
  sourceUrl: "https://www.linkedin.com/jobs/view/123", applyUrl: "https://www.linkedin.com/jobs/view/123", isEasyApply: true, workplaceType: "remote", posterName: "Sam Recruiter" };
const application = { url: "https://jobs.mews.com/123", company: job.company, title: job.title, applicationsOpen: true, free: true, evidence: "The page has an open application form with a submit button." };
const result = { decision: "save", company: job.company, title: job.title, role, application };
const email = { email: "hiring@mews.com", kind: "application", company: "Mews", source: "description", sourceQuote: "Apply by email to hiring@mews.com." };

test("clear excluded titles are rejected without approving any engineering-looking title", () => {
  for (const title of ["Business Analyst", "Senior Business Systems Analyst", "Data Analyst", "Product Manager", "Project Manager",
    "Programme Manager", "Scrum Master", "IT Support Engineer", "Technical Support Specialist", "Manual QA Tester", "Recruiter", "Sales Executive"]) {
    const target = { ...job, title };
    assert.ok(policy.roleSkipReason(target), title);
    assert.equal(policy.needsResearch(target), false, title);
    assert.equal(policy.verifiedJob(target, { ...result, title, application: { ...application, title } }), null, title);
  }
  for (const title of ["Senior JavaScript Engineer", ".NET Developer", "Software Engineer", "Platform Engineer", "Product Builder",
    "Solutions Engineer", "Systems Engineer", "Automation Engineer", "Technical Consultant", "Technical Architect", "Salesforce Developer", "Business Intelligence Developer"]) {
    const target = { ...job, title };
    assert.equal(policy.roleSkipReason(target), "", title);
    assert.equal(policy.needsResearch(target), true, title);
    assert.equal(policy.verifiedJob(target, { ...result, title, role: undefined }), null, title);
  }
});

test("Senior JavaScript Engineer and .NET Developer require GPT duties evidence on both Apply paths", () => {
  for (const [title, evidence] of [["Senior JavaScript Engineer", "Design and build JavaScript services, maintain production APIs and write automated tests."],
    [".NET Developer", "Develop C# and .NET applications, implement backend services and maintain automated tests."]]) {
    for (const isEasyApply of [true, false]) {
      const target = { ...job, title, isEasyApply, description: evidence };
      const findings = { ...result, title, role: { ...role, evidence }, application: isEasyApply ? { ...application, title } : undefined };
      assert.ok(policy.verifiedJob(target, findings), `${title}: ${isEasyApply}`);
      for (const invalidRole of [undefined, { ...role, eligible: false }, { ...role, category: "unclear" }, { ...role, category: "other" },
        { ...role, category: "unrecognized" }, { ...role, evidence: "Invented engineering duties for this job" }, { ...role, evidence: title }]) {
        assert.equal(policy.verifiedJob(target, { ...findings, role: invalidRole }), null, `${title}: ${JSON.stringify(invalidRole)}`);
      }
    }
  }
});

test("all six engineering families require explicit classification backed by captured duties", () => {
  const families = [
    ["Software Engineer", "software-development", "Implement software applications and maintain production services."],
    ["Frontend Developer", "web-development", "Build accessible web interfaces and automated frontend tests."],
    ["Android Developer", "mobile-development", "Develop Android applications and maintain their mobile release pipeline."],
    ["SRE", "infrastructure-engineering", "Build deployment automation and manage cloud infrastructure through code."],
    ["ML Engineer", "data-ai-engineering", "Implement machine learning pipelines and deploy production model services."],
    ["SDET", "test-automation", "Develop automated software testing frameworks and integration tests."]
  ];
  for (const [title, category, evidence] of families) {
    const target = { ...job, title, description: evidence, isEasyApply: false };
    assert.ok(policy.verifiedJob(target, { ...result, title, application: undefined, role: { eligible: true, category, evidence } }), title);
  }
});

test("Easy Apply requires an exact active free route; the external URL replaces LinkedIn", () => {
  const saved = policy.verifiedJob(job, result);
  assert.equal(saved.applyUrl, application.url);
  assert.match(saved.info, /LinkedIn job: https:\/\/www.linkedin.com\/jobs\/view\/123/);
  assert.equal(saved.info.includes(application.url), false);
  for (const delta of [{ title: "Product Builder" }, { company: "Another Company" }, { applicationsOpen: false }, { free: false }, { url: "https://www.linkedin.com/jobs/view/123" }]) {
    assert.equal(policy.verifiedJob(job, { ...result, application: { ...application, ...delta } }), null);
  }
  assert.equal(policy.verifiedJob(job, { ...result, title: "Product Builder" }), null);
  assert.equal(policy.verifiedJob({ ...job, applicationsClosed: true }, result), null);
  assert.equal(policy.verifiedJob(job, { ...result, application: undefined }), null);
});
test("Hybrid and On-site require a quote from this JD before any application route qualifies", () => {
  for (const workplaceType of ["hybrid", "on-site", "unknown"]) {
    const target = { ...job, workplaceType };
    assert.equal(policy.needsResearch(target), true);
    assert.equal(policy.verifiedJob(target, result), null);
    assert.equal(policy.verifiedJob(target, { ...result, fullyRemote: true, remoteEvidence: "Invented fully remote text" }), null);
    assert.equal(policy.verifiedJob(target, { ...result, fullyRemote: true, remoteEvidence: "Apply by email to hiring@mews.com." }), null);
    const saved = policy.verifiedJob(target, { ...result, fullyRemote: true, remoteEvidence: "This role offers fully remote work." });
    assert.match(saved.info, /Fully remote confirmed/);
  }
  assert.equal(policy.needsResearch({ ...job, isEasyApply: false }), true);
  assert.ok(policy.verifiedJob({ ...job, workplaceType: "hybrid", isEasyApply: false }, { ...result, application: undefined, fullyRemote: true, remoteEvidence: "This role offers fully remote work." }));
});

test("nonremote labels with no explicit fully remote offer are rejected even with a valid application route", () => {
  const descriptions = [
    "Hybrid role with flexible hours. Apply by email to hiring@mews.com.",
    "You can work from home two days a week.",
    "We are a remote-first company with flexible working.",
    "This is not a fully remote role.",
    "Fully remote work is not available for this position.",
    "This role may become fully remote in future.",
    "A fully remote arrangement is possible only after probation.",
    "We provide equipment for fully remote employees.",
    "This role is fully remote. You must attend the office two days per week.",
    "This role is fully remote. Work in the office 2 days per week.",
    "This role is fully remote. Office attendance is required.",
    ""
  ];
  for (const workplaceType of ["hybrid", "on-site", "unknown", "Hybrid", undefined]) {
    for (const description of descriptions) {
      const target = { ...job, workplaceType, description };
      assert.ok(policy.remoteSkipReason(target), `${workplaceType}: ${description}`);
      assert.equal(policy.verifiedJob(target, { ...result, fullyRemote: true, remoteEvidence: description }), null);
    }
  }
});

test("explicit fully remote offers allow the remote check without accepting remote-first or partial home working", () => {
  for (const description of [
    "This role is fully remote.", "Location: 100% remote within the UK.",
    "This position is completely remote.", "Work from anywhere in the UK.",
    "This is a remote-only role.", "Full-time remote work is available for this position.",
    "This role is fully remote. No mandatory office attendance.",
    "This role is fully remote. Office attendance is optional."
  ]) {
    const target = { ...job, workplaceType: "hybrid", description: `${duties} ${description}` };
    assert.equal(policy.remoteSkipReason(target), "", description);
    assert.ok(policy.verifiedJob(target, { ...result, fullyRemote: true, remoteEvidence: description }), description);
  }
  assert.equal(policy.remoteSkipReason({ ...job, workplaceType: "remote", description: "A job description." }), "");
});
test("a published application email qualifies without a URL and preserves the reference URL", () => {
  const saved = policy.verifiedJob(job, { ...result, application: undefined, emails: [email] });
  assert.equal(saved.applyUrl, job.applyUrl);
  assert.match(saved.info, /Application email: hiring@mews.com \(job description\)/);
  for (const delta of [{ email: "guess@mews.com" }, { company: "Other" }, { sourceQuote: "Please email an address." }, { source: "public", sourceUrl: "https://linkedin.com/in/person" }]) {
    assert.equal(policy.verifiedJob(job, { ...result, application: undefined, emails: [{ ...email, ...delta }] }), null);
  }
});
test("job-poster email requires the scraped person's identity and a public source", () => {
  const poster = { ...email, kind: "poster", source: "public", sourceUrl: "https://mews.com/team/sam", posterName: "Sam Recruiter", sourceQuote: "Sam Recruiter: hiring@mews.com" };
  assert.ok(policy.verifiedJob(job, { ...result, application: undefined, emails: [poster] }));
  assert.equal(policy.verifiedJob(job, { ...result, application: undefined, emails: [{ ...poster, posterName: "Another Sam" }] }), null);
  assert.equal(policy.verifiedJob({ ...job, posterName: "" }, { ...result, application: undefined, emails: [poster] }), null);
});
test("a verified email application page replaces Apply URL and keeps the complete LinkedIn source and email in Info", () => {
  const descriptionEvidence = "Most of its audience already uses the platform on mobile, so this is not an experimental side project searching for users. The audience and product already exist.";
  const target = { ...job, company: "Pathfinder Recruitment", title: "Full Stack Developer", description: `${duties} ${descriptionEvidence}`,
    applyUrl: "", sourceUrl: "https://www.linkedin.com/jobs/search-results/?currentJobId=4464464409&refId=edBBsjrli33RfbLoUjsCMA%3D%3D&keywords=remote%20developer", info: "Existing note" };
  const url = "https://www.itistheway.co.uk/jobs/react-native-developer";
  const published = { email: "application@itistheway.co.uk", kind: "application", company: target.company, source: "public", sourceUrl: url,
    sourceQuote: "Apply now! TAKE THIS PATH (application@itistheway.co.uk)" };
  const page = { url, title: "React Native Developer", company: target.company, route: "email", applicationsOpen: true, free: true,
    evidence: published.sourceQuote, descriptionEvidence };
  const findings = { decision: "save", company: target.company, title: target.title, role, application: page, emails: [published] };
  const saved = policy.verifiedJob(target, findings);
  assert.equal(saved.applyUrl, url);
  assert.equal(saved.info, `Existing note | LinkedIn job: ${target.sourceUrl} | Application email: application@itistheway.co.uk`);
  // Neither the differing title alone nor an arbitrary public email source
  // establishes a matching, open email application page.
  for (const delta of [{ route: "web" }, { route: undefined }, { route: "other" }, { descriptionEvidence: "" },
    { descriptionEvidence: "Unrelated vacancy description ".repeat(8) }, { evidence: "A contact address exists on this website." },
    { company: "Other" }, { applicationsOpen: false }, { free: false }, { url: "https://linkedin.com/jobs/1" }]) {
    const fallback = policy.verifiedJob(target, { ...findings, application: { ...page, ...delta } });
    assert.equal(fallback.applyUrl, target.sourceUrl, JSON.stringify(delta));
    assert.ok(fallback.info.includes(`(${url})`));
  }
  assert.equal(policy.verifiedJob(target, { ...findings, emails: [] }), null);
  const elsewhere = policy.verifiedJob(target, { ...findings, emails: [{ ...published, sourceUrl: "https://www.itistheway.co.uk/contact" }] });
  assert.equal(elsewhere.applyUrl, target.sourceUrl);
});
test("web application pages preserve LinkedIn and avoid repeating their URL as an email source", () => {
  const publicEmail = { ...email, source: "public", sourceUrl: `${application.url}#apply`, sourceQuote: "Apply now: hiring@mews.com" };
  const poster = { ...publicEmail, kind: "poster", sourceUrl: "https://mews.com/team/sam", posterName: "Sam Recruiter" };
  const saved = policy.verifiedJob({ ...job, sourceUrl: "", info: "Keep this note" }, { ...result, emails: [publicEmail, poster] });
  assert.equal(saved.applyUrl, application.url);
  assert.equal(saved.info, `Keep this note | LinkedIn job: ${job.applyUrl} | Application email: hiring@mews.com`);
  const withPoster = policy.verifiedJob(job, { ...result, emails: [{ ...poster, email: "sam@mews.com", sourceQuote: "Sam Recruiter: sam@mews.com" }] });
  assert.ok(withPoster.info.includes("Job poster email: sam@mews.com (https://mews.com/team/sam)"));
  assert.equal(policy.verifiedJob({ ...job, info: `LinkedIn job: ${job.sourceUrl}` }, result).info.split(job.sourceUrl).length, 2);
});
test("URLs reject LinkedIn wrappers, unsafe destinations and paid-route claims", () => {
  for (const url of ["http://jobs.mews.com/a", "https://linkedin.com/jobs/1", "https://uk.linkedin.com/jobs/1", "https://localhost/a", "https://127.0.0.1/a", "https://[::1]/a", "https://user:pass@mews.com/a", "https://mews.com:8787/a", "https://jobs.test/a", "https://mews.com/go?url=https%253A%252F%252Flinkedin.com%252Fjobs%252F1"]) assert.equal(policy.publicUrl(url), "", url);
  assert.equal(policy.publicUrl("https://jobs.mews.com/a?gh_jid=123"), "https://jobs.mews.com/a?gh_jid=123");
  assert.equal(policy.validEmail("privacy@mews.com"), "");
});
