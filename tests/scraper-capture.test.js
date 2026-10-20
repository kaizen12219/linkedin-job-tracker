const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(require.resolve("../src/scraper.js"), "utf8");
function scrape(t, label, button, { closed = false, link = true, modern = false, standalone = false, country = "", sourceUrl = "https://www.linkedin.com/jobs/search/?currentJobId=321" } = {}) {
  const dom = new JSDOM(`<header>${country ? `<button>${country}</button>` : ""}</header><main><nav><button>Remote</button><button>Easy Apply</button></nav>
    <li data-occludable-job-id="999"><a href="/jobs/view/999">Other job</a><a href="https://other.com/apply">Apply</a><span>Remote</span></li>
    <div class="jobs-search__job-details--container"><div class="job-details-jobs-unified-top-card">
    <a href="/company/mews">Mews</a><${standalone ? "p" : modern ? "h2" : "h1"}>${link ? '<a href="/jobs/view/123">Product Builder - Fintech</a>' : 'Product Builder - Fintech'}</${standalone ? "p" : modern ? "h2" : "h1"}>
    <span>${label}</span><button aria-label="${button} for Product Builder">${button}</button>${closed ? '<p>No longer accepting applications</p>' : ''}</div>
    <div data-testid="job-poster"><a href="/in/sam">Sam Recruiter</a></div>
    <section componentkey="JobDetails_AboutTheJob"><div data-testid="expandable-text-box">This role offers fully remote work. Apply to hiring@mews.com.</div></section></div></main>`, { url: sourceUrl, runScripts: "outside-only" });
  t.after(() => dom.window.close()); dom.window.eval(fs.readFileSync(require.resolve("../src/profile-routing.js"), "utf8")); dom.window.eval(source);
  return dom.window.LinkedInJobScraper.scrape();
}
test("selected job labels override unrelated Remote and Easy Apply search filters", (t) => {
  const data = scrape(t, "On-site", "Apply");
  assert.equal(data.company, "Mews"); assert.equal(data.title, "Product Builder - Fintech");
  assert.equal(data.workplaceType, "on-site"); assert.equal(data.isEasyApply, false);
  assert.equal(data.applicationsAvailable, true);
  assert.equal(data.jobId, "123"); assert.equal(data.jobIdSource, "details");
  assert.equal(data.posterName, "Sam Recruiter"); assert.deepEqual(Array.from(data.descriptionEmails), ["hiring@mews.com"]);
  assert.notEqual(data.applyUrl, "https://other.com/apply");
});

test("scraping records the search dropdown's country and source for each selected job", (t) => {
  for (const [country, selectedRegion] of [["United Kingdom", "uk"], ["United States", "us"], ["Colombia", "colombia"], ["Latin America", "latam"]]) {
    const data = scrape(t, "Remote", "Apply", { country, sourceUrl: "https://www.linkedin.com/jobs/search/?geoId=103644278" });
    assert.equal(data.selectedRegion, selectedRegion); assert.equal(data.selectedRegionSource, "search-control");
  }
  assert.equal(scrape(t, "Remote", "Apply", { sourceUrl: "https://www.linkedin.com/jobs/search/?geoId=101165590" }).selectedRegion, "uk");
});
test("Remote, Hybrid, unknown, Easy Apply and closed applications are captured", (t) => {
  for (const [label, expected] of [["✓ Remote", "remote"], ["Hybrid", "hybrid"], ["", "unknown"]]) {
    const data = scrape(t, label, "Easy Apply", { closed: true });
    assert.equal(data.workplaceType, expected); assert.equal(data.isEasyApply, true); assert.equal(data.applicationsClosed, true);
  }
});
test("a changed search URL alone is not treated as proof that job details have changed", (t) => {
  const data = scrape(t, "Remote", "Easy Apply", { link: false });
  assert.equal(data.jobId, "321"); assert.equal(data.jobIdSource, "query");
});
test("generated modern headings still provide the selected detail identity", (t) => {
  const data = scrape(t, "Hybrid", "Easy Apply", { modern: true });
  assert.equal(data.jobId, "123"); assert.equal(data.jobIdSource, "details"); assert.equal(data.title, "Product Builder - Fintech");
});

test("a standalone selected-title link proves its job ID without using an unrelated card or the stale URL", (t) => {
  const data = scrape(t, "Remote", "Easy Apply", { standalone: true });
  assert.equal(data.jobId, "123"); assert.equal(data.jobIdSource, "details");
  assert.equal(data.title, "Product Builder - Fintech"); assert.equal(data.company, "Mews");
  assert.equal(data.isEasyApply, true); assert.equal(data.workplaceType, "remote");
});
test("missing Apply controls cannot be mistaken for an ordinary external-apply job", (t) => {
  const data = scrape(t, "Remote", "");
  assert.equal(data.applicationsAvailable, false);
});

function descriptionRenderFixture(t) {
  const description = "Design and build production data services, maintain automated tests, and improve service reliability. ".repeat(3);
  const dom = new JSDOM(`<div class="jobs-details"><div class="job-details-jobs-unified-top-card"><h1><a href="/jobs/view/101/">Senior Software Engineer</a></h1>
    <a href="/company/bigid/">BigID</a><button>Remote</button><button>Easy Apply</button></div>
    <section componentkey="JobDetails_AboutTheJob"><div data-testid="expandable-text-box">${description}</div></section></div>`,
    { url: "https://www.linkedin.com/jobs/search/?currentJobId=101", runScripts: "outside-only" });
  t.after(() => dom.window.close()); dom.window.eval(source);
  return { api: dom.window.LinkedInJobScraper, document: dom.window.document, window: dom.window };
}

test("LinkedIn description render identity stays stable for an unchanged body despite header and URL updates", (t) => {
  const { api, document, window } = descriptionRenderFixture(t);
  const first = api.scrape();
  assert.equal(typeof first.descriptionRenderId, "string");
  assert.ok(first.descriptionRenderId.length > 0);
  assert.equal(api.scrape().descriptionRenderId, first.descriptionRenderId);
  const title = document.querySelector("h1 a"); title.href = "/jobs/view/102/";
  title.textContent = "SENIOR SOFTWARE ENGINEER";
  window.history.replaceState({}, "", "?currentJobId=102");
  const headerChanged = api.scrape();
  assert.equal(headerChanged.jobId, "102"); assert.equal(headerChanged.jobIdSource, "details");
  assert.equal(headerChanged.descriptionRenderId, first.descriptionRenderId);
  assert.equal(headerChanged.description, first.description);
  assert.equal(JSON.parse(JSON.stringify(headerChanged)).descriptionRenderId, first.descriptionRenderId);
  assert.ok(Object.values(headerChanged).every(value => !value || typeof value !== "object" || value.nodeType === undefined));
});

test("LinkedIn gives fresh description render identities to equal-text replacement nodes and text revisions", (t) => {
  const { api, document } = descriptionRenderFixture(t);
  const first = api.scrape();
  const original = document.querySelector("[data-testid='expandable-text-box']");
  const replacement = original.cloneNode(true); original.replaceWith(replacement);
  const replaced = api.scrape();
  assert.equal(original.isConnected, false);
  assert.equal(replaced.description, first.description);
  assert.notEqual(replaced.descriptionRenderId, first.descriptionRenderId);
  assert.equal(api.scrape().descriptionRenderId, replaced.descriptionRenderId);
  replacement.textContent += " Maintain newly introduced software services.";
  const changed = api.scrape();
  assert.notEqual(changed.descriptionRenderId, replaced.descriptionRenderId);
  assert.equal(api.scrape().descriptionRenderId, changed.descriptionRenderId);
  replacement.remove();
  const missing = api.scrape();
  assert.equal(missing.description, ""); assert.equal(missing.descriptionRenderId, "");
});

test("a global description fallback outside the selected details keeps its text without render authority", (t) => {
  const { api, document } = descriptionRenderFixture(t);
  const selected = api.scrape();
  assert.ok(selected.descriptionRenderId);
  const foreign = document.querySelector("[componentkey='JobDetails_AboutTheJob']");
  document.body.append(foreign);
  const fallback = api.scrape();
  assert.equal(fallback.jobId, "101"); assert.equal(fallback.jobIdSource, "details");
  assert.equal(fallback.description, selected.description, "existing fallback extraction still returns the same text");
  assert.equal(fallback.descriptionRenderId, "", "a description from outside the selected detail cannot authorize a fresh render");
});
