const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const fixture = require("./fixtures/jobright-page.js");
function setup(t, { html = fixture.page(), url = `https://jobright.ai/jobs/info/${fixture.A}` } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" }); t.after(() => dom.window.close());
  dom.window.eval(fs.readFileSync(require.resolve("../src/jobright-scraper.js"), "utf8"));
  return { api: dom.window.JobrightJobScraper, document: dom.window.document, window: dom.window };
}
test("Jobright details extract observed JD sections and exclude private/AI/company material", (t) => {
  const { api, document } = setup(t);
  const value = api.scrape(document, `https://jobright.ai/jobs/info/${fixture.A}?utm_source=feed`);
  assert.equal(value.jobId, fixture.A); assert.equal(value.jobIdSource, "details");
  assert.equal(value.title, "Software Engineer 1"); assert.equal(value.company, "Company 1");
  assert.match(value.description, /Responsibilities\n- Build production software/u);
  assert.match(value.description, /Required\n- 5\+ years/u); assert.match(value.description, /Preferred\n- Distributed/u);
  assert.match(value.description, /Benefits\n- Health insurance/u);
  assert.doesNotMatch(value.description, /AI generated|private@example|Jane Doe|CEO|worldwide strategy|Excellent fit/u);
  assert.equal(value.selectedRegion, "us"); assert.equal(value.selectedRegionSource, "search-control");
  assert.equal(value.workplaceType, "remote"); assert.equal(value.isEasyApply, true);
  assert.equal(value.applyUrl, `https://careers.example.com/${fixture.A}`);
  assert.equal(value.sourceUrl, `https://jobright.ai/jobs/info/${fixture.A}`);
});
test("only committed visible country controls determine region and frozen search context", (t) => {
  const { api, document } = setup(t);
  const first = api.searchContext(document, `https://jobright.ai/jobs/info/${fixture.A}`);
  assert.equal(first.filterKey, api.searchContext(document, "https://jobright.ai/jobs/recommend").filterKey);
  document.body.insertAdjacentHTML("beforeend", `<div data-preference-key="country" data-topbar-state="active" style="display:none"><button><span title="United Kingdom">United Kingdom</span></button></div><div role="dialog"><input value="United Kingdom"></div>`);
  assert.equal(api.searchContext().filterKey, first.filterKey);
  document.querySelector("[data-preference-key='workLocation'] span").setAttribute("title", "Hybrid");
  assert.notEqual(api.searchContext().filterKey, first.filterKey);
  document.querySelector("[data-preference-key='country'] span").setAttribute("title", "United Kingdom");
  assert.equal(api.searchContext().selectedRegion, "");
  document.querySelector("[data-preference-key='country']").remove();
  assert.equal(api.searchContext().filterKey, ""); assert.equal(api.searchContext().selectedRegion, "");
});
test("cards require matching 24 hex IDs and the actual title link", (t) => {
  const { api, document } = setup(t, { html: fixture.page([fixture.job(), fixture.job(fixture.B)]) });
  document.querySelector("main").insertAdjacentHTML("beforeend", `<div class="job-card-flag-classname" id="123"><a href="/jobs/info/${fixture.B}"><h2 class="index_job-title__x">Other</h2></a></div>`);
  const cards = api.cards(); assert.deepEqual(Array.from(cards, (record) => record.id), [fixture.A, fixture.B]);
  assert.ok(cards.every((record) => record.link.querySelector("h2")));
  assert.ok(cards.every((record) => !record.link.hasAttribute("data-match")));
});
test("missing details, unsupported origin, and AI-only content fail closed", (t) => {
  const { api, document } = setup(t);
  for (const url of ["https://jobright.ai/jobs/recommend", `https://jobright.ai.evil.test/jobs/info/${fixture.A}`, "https://jobright.ai/jobs/info/not-an-id"]) assert.throws(() => api.scrape(document, url), /Open a Jobright/u);
  document.querySelector("#overview-1").innerHTML = "<h2>Why this job matches you</h2><p>Software engineer with 5 years of experience.</p>";
  assert.throws(() => api.scrape(), /not readable/u);
});
test("navigation URL alone cannot make stale rendered details a different job", (t) => {
  const { api, document } = setup(t);
  const next = fixture.job(fixture.B, { company: "Company 1", title: "Software Engineer 1" });
  document.querySelector("main").insertAdjacentHTML("beforeend", fixture.card(next));
  assert.throws(() => api.scrape(document, `https://jobright.ai/jobs/info/${fixture.B}`), /still changing/u);
  document.querySelector("[data-time-filter-job]").remove();
  assert.throws(() => api.scrape(), /still changing/u);
});
test("missing, draft, or non-US country filters cannot select a US profile", (t) => {
  const { api, document } = setup(t);
  const country = document.querySelector("[data-preference-key='country']");
  country.querySelector("span").setAttribute("title", "United Kingdom");
  assert.throws(() => api.scrape(), /Select United States/u);
  country.removeAttribute("data-topbar-state");
  country.querySelector("span").setAttribute("title", "United States");
  assert.throws(() => api.scrape(), /Select United States/u);
  country.remove(); document.body.insertAdjacentHTML("beforeend", "<input value='United States'><p>US remote jobs</p>");
  assert.throws(() => api.scrape(), /Select United States/u);
});
test("external Original Job Post is optional and only explicit job controls mark closure", (t) => {
  const { api, document } = setup(t);
  document.querySelector("a[href^='https://careers']").remove();
  assert.equal(api.scrape().applyUrl, `https://jobright.ai/jobs/info/${fixture.A}`);
  document.querySelector("#details").insertAdjacentHTML("beforeend", "<p>No longer accepting applications</p>");
  assert.equal(api.scrape().applicationsClosed, false, "unrelated page text is outside the selected panel");
  document.querySelector(".index_jobDetailContent__rhs3U").insertAdjacentHTML("beforeend", "<p>No longer accepting applications</p>");
  assert.equal(api.scrape().applicationsClosed, true);
});
test("a missing or disabled Apply control cannot be treated as an active application", (t) => {
  const { api, document } = setup(t);
  const button = document.querySelector("#apply-now-button-id"); button.disabled = true;
  assert.equal(api.scrape().applicationsAvailable, false);
  button.remove(); assert.equal(api.scrape().applicationsAvailable, false); assert.equal(api.scrape().applicationsClosed, false);
});
