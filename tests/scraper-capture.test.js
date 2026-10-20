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

function descriptionFixture(t, { body = '', rootClass = 'jobs-details', rootAttributes = '', outside = '' } = {}) {
  const dom = new JSDOM(`<main><div class="${rootClass}" ${rootAttributes}><div class="job-details-jobs-unified-top-card"><h1><a href="/jobs/view/101/">Senior Software Engineer</a></h1>
    <a href="/company/bigid/">BigID</a><button>Remote</button><button>Easy Apply</button></div>${body}</div>${outside}</main>`,
    { url: "https://www.linkedin.com/jobs/search/?currentJobId=101", runScripts: "outside-only" });
  t.after(() => dom.window.close()); dom.window.eval(source);
  return { api: dom.window.LinkedInJobScraper, document: dom.window.document, window: dom.window };
}

test("modern plain About sections preserve full paragraphs and lists without an expandable wrapper", (t) => {
  const { api } = descriptionFixture(t, { body: '<section componentkey="JobDetails_AboutTheJob"><h2>About the job</h2><p>Build production data services.</p><h3>Responsibilities</h3><ul><li>Design reliable APIs.</li><li>Maintain automated tests.</li></ul><button>Show more</button><section componentkey="JobDetails_AboutTheCompany"><h2>About the company</h2><p>PRIVATE_COMPANY_MARKETING</p></section></section>' });
  const value = api.scrape();
  assert.match(value.description, /Build production data services\./u);
  assert.match(value.description, /Responsibilities\n- Design reliable APIs\.\n- Maintain automated tests\./u);
  assert.doesNotMatch(value.description, /About the job|Show more|PRIVATE_COMPANY|Senior Software Engineer|BigID/u);
  assert.equal(value.descriptionRenderId, undefined);
  assert.equal(value.jobId, '101'); assert.equal(value.jobIdSource, 'details');
});

for (const attributes of ['componentkey="JobDetails_AboutTheJob"', 'class="jobs-box__html-content"']) test(`an authored JD keeps its company introduction, responsibilities, and experience requirements: ${attributes}`, (t) => {
  const { api } = descriptionFixture(t, { body: `<section ${attributes}><h2>About the company</h2><p>We build data security products for enterprise customers.</p><h2>Responsibilities</h2><p>Design, build, and test production software services.</p><h2>Qualifications</h2><p>5+ years of professional software engineering experience required.</p></section>` });
  const value = api.scrape().description;
  assert.match(value, /About the company\nWe build data security products/u);
  assert.match(value, /Responsibilities\nDesign, build, and test production software services/u);
  assert.match(value, /Qualifications\n5\+ years of professional software engineering experience required/u);
});

test("a loading About placeholder remains empty until its plain job description hydrates", (t) => {
  const { api, document } = descriptionFixture(t, { body: '<section componentkey="JobDetails_AboutTheJob" aria-busy="true"><h2>About the job</h2><div data-testid="expandable-text-box">Loading job description...</div></section>',
    outside: '<section data-testid="job-description"><div data-testid="expandable-text-box">FOREIGN_JOB_DESCRIPTION must never substitute for a loading selected job.</div></section>' });
  assert.equal(api.scrape().description, '');
  const section = document.querySelector('[componentkey="JobDetails_AboutTheJob"]');
  section.removeAttribute('aria-busy');
  assert.equal(api.scrape().description, '');
  section.innerHTML = '<h2>About the job</h2><p>Build and operate reliable software services.</p><p>Collaborate on production engineering changes.</p>';
  assert.equal(api.scrape().description, 'Build and operate reliable software services.\nCollaborate on production engineering changes.');
});

for (const body of ['<div class="jobs-description__content"><div class="jobs-box__html-content"><p>Build SQL pipelines.</p></div></div>',
  '<article id="job-details"><h2>Job description</h2><p>Build SQL pipelines.</p></article>',
  '<div class="description__text"><div class="show-more-less-html__markup"><p>Build SQL pipelines.</p></div></div>']) test(`legacy job-view descriptions do not require test attributes or a length threshold: ${body.slice(0, 42)}`, (t) => {
  const { api } = descriptionFixture(t, { rootClass: 'job-view-layout', body });
  assert.equal(api.scrape().description, 'Build SQL pipelines.');
});

test("plain heading-following descriptions stop at unrelated company sections", (t) => {
  const { api } = descriptionFixture(t, { body: '<div><header><h2>About this role</h2></header><div><p>Build production services.</p><ul><li>Test deployed software.</li></ul></div><section><h2>About the company</h2><p>COMPANY_MARKETING</p><div data-testid="expandable-text-box">UNRELATED_LONG_BODY should not be selected as the job description.</div></section></div>' });
  assert.equal(api.scrape().description, 'Build production services.\n- Test deployed software.');
});

test("an unhydrated plain About section cannot borrow a later Premium or company body", (t) => {
  const { api } = descriptionFixture(t, { body: '<section><header><h2>About the job</h2></header><p>Loading...</p></section><section><h2>Stand out with Premium</h2><p>UNRELATED_PREMIUM_TEXT</p><div data-testid="expandable-text-box">UNRELATED_EXPANDER_TEXT</div></section>' });
  assert.equal(api.scrape().description, '');
});

test("foreign global bodies, list cards, and company expanders cannot fill a missing selected job description", (t) => {
  const { api } = descriptionFixture(t, { body: '<section><h2>About the company</h2><div data-testid="expandable-text-box">COMPANY_DESCRIPTION with enough prose to exceed the previous global longest-expander threshold. We describe company history and corporate benefits rather than this position.</div></section><li data-occludable-job-id="999"><div data-testid="expandable-text-box">OTHER_CARD_DESCRIPTION</div></li>',
    outside: '<section componentkey="JobDetails_AboutTheJob"><div data-testid="expandable-text-box">FOREIGN_JOB_DESCRIPTION</div></section>' });
  assert.equal(api.scrape().description, '');
  assert.equal(api.descriptionTarget(), null);
});

test("an About marker on the selected root itself is read without its selected-job header", (t) => {
  const { api } = descriptionFixture(t, { rootAttributes: 'componentkey="JobDetails_AboutTheJob"', body: '<h2>About the job</h2><p>Build software from the selected root.</p>' });
  assert.equal(api.scrape().description, 'Build software from the selected root.');
});

test("a busy selected detail waits for loading to finish even when old text is still mounted", (t) => {
  const { api, document } = descriptionFixture(t, { rootAttributes: 'aria-busy="true"', body: '<div class="jobs-box__html-content"><p>Old mounted description must not be captured during loading.</p></div>' });
  assert.equal(api.scrape().description, '');
  document.querySelector('.jobs-details').removeAttribute('aria-busy');
  assert.equal(api.scrape().description, 'Old mounted description must not be captured during loading.');
});

for (const oldAttributes of ['hidden aria-busy="true"', 'style="display:none"', 'aria-hidden="true"', 'aria-busy="true"']) test(`a retained unavailable panel cannot mask the visible current details: ${oldAttributes}`, (t) => {
  const { api, document, window } = descriptionFixture(t, { rootAttributes: oldAttributes,
    body: '<section componentkey="JobDetails_AboutTheJob"><h2>About the job</h2><p>OLD_JOB_DESCRIPTION</p></section>',
    outside: '<div class="jobs-details"><div class="job-details-jobs-unified-top-card"><h1><a href="/jobs/view/202/">Current Software Engineer</a></h1><a href="/company/current/">Current Employer</a><button>Remote</button><button>Apply</button></div><section componentkey="JobDetails_AboutTheJob"><h2>About the job</h2><p>Build services for the current selected job.</p></section></div>' });
  window.history.replaceState({}, '', '?currentJobId=202');
  const value = api.scrape();
  assert.equal(value.jobId, '202'); assert.equal(value.jobIdSource, 'details');
  assert.equal(value.title, 'Current Software Engineer'); assert.equal(value.company, 'Current Employer');
  assert.equal(value.description, 'Build services for the current selected job.');
  assert.equal(api.descriptionTarget(), document.querySelectorAll('.jobs-details')[1].querySelector('h2'));
});

test("only hidden recognized panels produce no description or lazy-load target", (t) => {
  const { api } = descriptionFixture(t, { rootAttributes: 'hidden', body: '<section componentkey="JobDetails_AboutTheJob"><h2>About the job</h2><p>HIDDEN_OLD_DESCRIPTION</p></section>' });
  assert.equal(api.scrape().description, '');
  assert.equal(api.descriptionTarget(), null);
});

test("descriptionTarget finds only the selected About heading or container for lazy loading", (t) => {
  const { api, document } = descriptionFixture(t, { body: '<section componentkey="JobDetails_AboutTheJob" aria-busy="true"><h2>About the job</h2><p>Loading...</p></section>',
    outside: '<section componentkey="JobDetails_AboutTheJob"><h2>About the job</h2><p>FOREIGN_JOB</p></section>' });
  const section = document.querySelector('.jobs-details [componentkey]');
  assert.equal(api.descriptionTarget(), section.querySelector('h2'));
  assert.equal(api.scrape().description, '');
  section.querySelector('h2').remove();
  assert.equal(api.descriptionTarget(), section);
  section.remove();
  assert.equal(api.descriptionTarget(), null);
  assert.ok(Object.values(api.scrape()).every(value => !value || typeof value !== 'object' || value.nodeType === undefined));
});
