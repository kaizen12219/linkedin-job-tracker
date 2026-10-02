const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(require.resolve("../src/scraper.js"), "utf8");
function scrape(t, label, button, { closed = false, link = true, modern = false, standalone = false } = {}) {
  const dom = new JSDOM(`<main><nav><button>Remote</button><button>Easy Apply</button></nav>
    <li data-occludable-job-id="999"><a href="/jobs/view/999">Other job</a><a href="https://other.com/apply">Apply</a><span>Remote</span></li>
    <div class="jobs-search__job-details--container"><div class="job-details-jobs-unified-top-card">
    <a href="/company/mews">Mews</a><${standalone ? "p" : modern ? "h2" : "h1"}>${link ? '<a href="/jobs/view/123">Product Builder - Fintech</a>' : 'Product Builder - Fintech'}</${standalone ? "p" : modern ? "h2" : "h1"}>
    <span>${label}</span><button aria-label="${button} for Product Builder">${button}</button>${closed ? '<p>No longer accepting applications</p>' : ''}</div>
    <div data-testid="job-poster"><a href="/in/sam">Sam Recruiter</a></div>
    <section componentkey="JobDetails_AboutTheJob"><div data-testid="expandable-text-box">This role offers fully remote work. Apply to hiring@mews.com.</div></section></div></main>`, { url: "https://www.linkedin.com/jobs/search/?currentJobId=321", runScripts: "outside-only" });
  t.after(() => dom.window.close()); dom.window.eval(source);
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
