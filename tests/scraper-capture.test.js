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

for (const title of ["Senior Software Engineer II, Conversational Search", "Search Engineer", "Search Results Engineer"]) test(`a selected ${title} title retains its exact rendered identity`, (t) => {
  const id = "4482033140", description = "Build reliable search infrastructure and maintain production services.";
  const dom = new JSDOM(`<title>Search jobs | LinkedIn</title><main>
    <header hidden><h1>Unrelated Search Engineer</h1><a href="/jobs/view/999">Search Engineer</a></header>
    <li data-occludable-job-id="999"><a href="/jobs/view/999">Other Search Engineer</a></li>
    <div data-sdui-screen="com.linkedin.sdui.flagshipnav.jobs.SemanticJobDetails">
      <div class="job-details-jobs-unified-top-card"><h1 hidden>Search jobs</h1>
        <p><a href="/jobs/view/${id}/">${title}</a></p><a href="/company/etsy">Etsy</a><button>Remote</button><button>Apply</button></div>
      <section componentkey="JobDetails_AboutTheJob_${id}"><h2>About the job</h2><div data-testid="expandable-text-box">${description}</div></section>
    </div></main>`, { url: "https://www.linkedin.com/jobs/search/?currentJobId=999", runScripts: "outside-only" });
  t.after(() => dom.window.close()); dom.window.eval(source);
  const value = dom.window.LinkedInJobScraper.scrape();
  assert.equal(value.title, title); assert.equal(value.company, "Etsy");
  assert.equal(value.jobId, id); assert.equal(value.jobIdSource, "details", "a stale query cannot replace the exact selected-title link");
  assert.equal(value.description, description);
});

for (const label of ["Search", "Job search", "Search jobs", "Search results", "Results", "Job results"]) test(`the ${label} navigation label is not a job title`, (t) => {
  const dom = new JSDOM(`<title>${label} | LinkedIn</title><main>
    <header hidden><h1>Hidden Search Engineer</h1><a href="/jobs/view/999">Hidden Search Engineer</a></header>
    <li data-occludable-job-id="999"><h1>Unrelated Search Engineer</h1><a href="/jobs/view/999">Unrelated Search Engineer</a></li>
    <div data-sdui-screen="com.linkedin.sdui.flagshipnav.jobs.SemanticJobDetails"><h1><a href="/jobs/view/4482033140/">${label}</a></h1>
      <a href="/company/etsy">Etsy</a><section componentkey="JobDetails_AboutTheJob_4482033140"><p>Build production software services.</p></section>
    </div></main>`, { url: "https://www.linkedin.com/jobs/search/?currentJobId=4482033140", runScripts: "outside-only" });
  t.after(() => dom.window.close()); dom.window.eval(source);
  assert.equal(dom.window.LinkedInJobScraper.scrape().title, "", "outside or hidden unrelated headers cannot substitute for this UI label");
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

for (const heading of ['<p><span>About the job</span></p>', '<div role="heading" aria-level="2"><span>About the job</span></div>',
  '<div><span>About the job</span></div>', '<div><p>About the job</p></div>']) test(`plain modern About headings expose their own description and lazy-load target: ${heading}`, (t) => {
  const { api, document } = descriptionFixture(t, { body: `<section>${heading}<div><p>Build production services.</p><ul><li>Maintain automated tests.</li></ul></div><section><p>About the company</p><p>UNRELATED_COMPANY_MARKETING</p></section></section>` });
  assert.equal(api.scrape().description, 'Build production services.\n- Maintain automated tests.');
  const target = api.descriptionTarget();
  assert.ok(document.querySelector('.jobs-details').contains(target));
  assert.equal(target.textContent.trim(), 'About the job');
  assert.equal(api.scrape().selectorsUsed.description, 'about-heading-content');
});

test("paragraph and accessible headings remain scoped, visible, and exact while a plain About body hydrates", (t) => {
  const { api, document } = descriptionFixture(t, { body: '<section><p hidden>About the job</p><p>Learn more about the job</p><div role="heading">About the job: unrelated help text</div></section>',
    outside: '<section><div role="heading">About the job</div><p>FOREIGN_DESCRIPTION</p></section>' });
  assert.equal(api.scrape().description, '');
  assert.equal(api.descriptionTarget(), null);
  const section = document.querySelector('.jobs-details section');
  section.innerHTML = '<p><span>About the job</span></p><p>Loading...</p>';
  assert.equal(api.scrape().description, '');
  assert.equal(api.descriptionTarget(), section.firstElementChild);
  section.lastElementChild.textContent = 'The selected description has finished loading.';
  assert.equal(api.scrape().description, 'The selected description has finished loading.');
});

test("description diagnostics identify an About section outside a narrow selected root without copying the JD or app state", (t) => {
  const { api, document } = descriptionFixture(t, { body: '<section componentkey="JobDetails_AboutTheJob"><p>About the job</p><p>PRIVATE_JOB_BODY</p><script>PRIVATE_APP_STATE</script></section><li data-occludable-job-id="999"><p>About the job</p><a href="/jobs/view/999/">Private other title</a></li>' });
  const header = document.querySelector('.job-details-jobs-unified-top-card');
  header.setAttribute('data-sdui-screen', 'SemanticJobDetails');
  header.setAttribute('data-testid', 'selected-header');
  const value = api.descriptionDiagnostics();
  assert.equal(value.root.tag, 'div');
  assert.equal(value.root.screen, 'SemanticJobDetails');
  assert.equal(value.root.testid, 'selected-header');
  assert.equal(value.scrapedTitle, 'Senior Software Engineer');
  assert.equal(value.scrapedCompany, 'BigID');
  assert.ok(value.scrapedTitle.length <= 200 && value.scrapedCompany.length <= 200);
  assert.deepEqual(Array.from(value.root.renderedJobIds), ['101']);
  assert.equal(value.readySource, 'not-found');
  assert.equal(value.descriptionLength, 0);
  assert.equal(value.counts.aboutHeadings, 0);
  assert.equal(value.counts.outsideAboutHeadings, 1);
  assert.equal(value.headings[0].tag, 'p');
  assert.equal(value.headings[0].label, 'About the job');
  assert.equal(value.headings[0].inSelectedRoot, false);
  assert.equal(value.headings[0].ancestors[0].componentkey, 'JobDetails_AboutTheJob');
  assert.equal(value.headings[0].commonAncestor.tag, 'div');
  assert.equal(value.headings[0].commonAncestor.jobCardCount, 1);
  assert.equal(value.viewport.width, 1024);
  assert.equal(value.viewport.target, null);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /PRIVATE_|Private other title|<script|\/jobs\/view/u);
  assert.equal(value.root.nodeType, undefined);
});

test("description diagnostics bound heading counts, ancestry, attributes, and serialized size", (t) => {
  const marker = 'component-marker-'.repeat(20);
  const nestedHeading = index => Array.from({ length: 8 }, (_, depth) => `<div componentkey="${marker}" data-testid="layer-${index}-${depth}">`).join('') +
    '<div role="heading" aria-level="2">About the job</div>' + '</div>'.repeat(8);
  const { api } = descriptionFixture(t, { rootAttributes: `componentkey="${marker}" aria-busy="true"`,
    body: '<section><p>About the job</p><p>Loading...</p></section>', outside: Array.from({ length: 6 }, (_, index) => nestedHeading(index)).join('') });
  const value = api.descriptionDiagnostics();
  assert.equal(value.root.ariaBusy, 'true');
  assert.equal(value.readySource, 'not-ready');
  assert.equal(value.counts.outsideAboutHeadings, 6);
  assert.ok(value.headings.filter(heading => !heading.inSelectedRoot).length <= 4);
  assert.ok(value.headings.every(heading => heading.ancestors.length <= 5));
  assert.ok(value.root.componentkey.length <= 64);
  assert.ok(JSON.stringify(value).length <= 3900);
  assert.ok(value.headings.some(heading => !heading.inSelectedRoot), 'outside-root evidence remains within the diagnostic budget');
});

const publicIdentity = { jobId: '4480734414', title: 'Sr Java Integration Engineer III', company: 'Mutual of Omaha',
  sourceUrl: 'https://www.linkedin.com/jobs/view/sr-java-integration-engineer-iii-at-mutual-of-omaha-4480734414' };
function publicJobHtml({ title = publicIdentity.title, company = publicIdentity.company, headerId = publicIdentity.jobId,
  canonical = `https://www.linkedin.com/jobs/view/${publicIdentity.jobId}/`, ogUrl = canonical, body = '<p>Build production Java integration services.</p><ul><li>Maintain automated tests.</li></ul><p>5+ years of software engineering experience required.</p>',
  after = '', header = true, description = true, closed = false } = {}) {
  return `<html><head>${canonical === null ? '' : `<link rel="canonical" href="${canonical}">`}${ogUrl === null ? '' : `<meta property="og:url" content="${ogUrl}">`}</head><body><main>
    ${header ? `<section class="top-card-layout" data-entity-urn="urn:li:jobPosting:${headerId}"><h1 class="top-card-layout__title">${title}</h1><a class="topcard__org-name-link" href="/company/mutual-of-omaha/">${company}</a>${closed ? '<span class="closed-job">No longer accepting applications</span>' : ''}</section>` : ''}
    ${description ? `<section class="description"><div class="description__text"><div class="show-more-less-html__markup">${body}</div></div></section>` : ''}${after}</main></body></html>`;
}

test("the public-page parser reads only the exact selected public header and authored description inertly", (t) => {
  const { api, window } = descriptionFixture(t);
  let fetched = false;
  window.fetch = () => { fetched = true; throw new Error('The parser must not fetch.'); };
  const related = '<aside class="related-jobs"><section class="top-card-layout"><h1 class="top-card-layout__title">Other Engineer</h1><a class="topcard__org-name-link">Other Employer</a></section><div class="description__text"><div class="show-more-less-html__markup">RELATED_JOB_BODY</div></div></aside>';
  const value = api.parsePublicDescription(publicJobHtml({ body: '<h2>About the company</h2><p>We build insurance software.</p><h2>Responsibilities</h2><p>Build production Java integration services.</p><ul><li>Maintain automated tests.</li></ul><p>5+ years of software engineering experience required.</p><p style="display:none">HIDDEN_STALE_BODY</p><form><p>PRIVATE_SIGN_IN_FORM</p><input value="PRIVATE_FORM_VALUE"></form><script>window.PUBLIC_SCRIPT_RAN=true;</script><script type="application/ld+json">{"description":"PRIVATE_APP_STATE"}</script><button>Show more</button>',
    after: related }), publicIdentity);
  assert.equal(value.jobId, publicIdentity.jobId);
  assert.equal(value.title, publicIdentity.title);
  assert.equal(value.company, publicIdentity.company);
  assert.equal(value.sourceUrl, publicIdentity.sourceUrl);
  assert.match(value.description, /About the company\nWe build insurance software\./u);
  assert.match(value.description, /Responsibilities\nBuild production Java integration services\./u);
  assert.match(value.description, /- Maintain automated tests\./u);
  assert.match(value.description, /5\+ years of software engineering experience required\./u);
  assert.doesNotMatch(value.description, /RELATED_|HIDDEN_|PRIVATE_|PUBLIC_SCRIPT_RAN|Show more/u);
  assert.equal(window.PUBLIC_SCRIPT_RAN, undefined);
  assert.equal(fetched, false);
  assert.ok(Object.values(value).every(field => typeof field === 'string'));
});

test("public numeric and slug URLs preserve case/whitespace-normalized exact header identity", (t) => {
  const { api } = descriptionFixture(t);
  const value = api.parsePublicDescription(publicJobHtml({ title: '  SR JAVA\n INTEGRATION ENGINEER III ', company: ' MUTUAL OF OMAHA ', canonical: '/jobs/view/4480734414/', ogUrl: null }),
    { ...publicIdentity, sourceUrl: 'https://www.linkedin.com/jobs/view/4480734414/' });
  assert.equal(value.jobId, publicIdentity.jobId);
  assert.equal(value.title, 'SR JAVA INTEGRATION ENGINEER III');
  assert.equal(value.company, 'MUTUAL OF OMAHA');
});

for (const changed of [{ title: 'Staff Java Integration Engineer III' }, { company: 'Other Insurance Company' }, { headerId: '999' },
  { canonical: 'https://www.linkedin.com/jobs/view/999/' }, { ogUrl: 'https://www.linkedin.com/jobs/view/different-role-999' },
  { canonical: 'https://evil.example/jobs/view/4480734414/' }, { canonical: '' }]) test(`the public parser rejects conflicting selected identity: ${Object.keys(changed)[0]}=${Object.values(changed)[0]}`, (t) => {
  const { api } = descriptionFixture(t);
  assert.equal(api.parsePublicDescription(publicJobHtml(changed), publicIdentity), null);
});

for (const sourceUrl of ['https://www.linkedin.com/jobs/view/999/', 'https://www.linkedin.com/authwall', 'https://www.linkedin.com/login',
  'https://evil.example/jobs/view/4480734414/', 'http://www.linkedin.com/jobs/view/4480734414/']) test(`public fallback rejects an unverified response URL: ${sourceUrl}`, (t) => {
  const { api } = descriptionFixture(t);
  assert.equal(api.parsePublicDescription(publicJobHtml(), { ...publicIdentity, sourceUrl }), null);
});

test("public login pages, empty descriptions, and related-only bodies cannot provide a fallback", (t) => {
  const { api } = descriptionFixture(t);
  for (const html of [publicJobHtml({ body: '' }), publicJobHtml({ body: '<p>Loading job description...</p>' }),
    publicJobHtml({ header: false, body: 'Sign in to view this job.' }),
    publicJobHtml({ description: false, after: '<aside class="related-jobs"><div class="description__text"><div class="show-more-less-html__markup">RELATED_ONLY_BODY</div></div></aside>' }),
    publicJobHtml({ body: '<form><p>Sign in to LinkedIn</p></form><script type="application/ld+json">{"description":"APP_STATE_ONLY_BODY"}</script>' }),
    '<main><h1>Sign in to LinkedIn</h1><form><input name="password"></form></main>']) {
    assert.equal(api.parsePublicDescription(html, publicIdentity), null);
  }
});

test("hidden or ambiguous public headers and job bodies are rejected rather than guessed", (t) => {
  const { api } = descriptionFixture(t);
  const html = publicJobHtml();
  for (const changed of [html.replace('class="top-card-layout"', 'class="top-card-layout" hidden'),
    html.replace('class="description__text"', 'class="description__text" style="display:none"'),
    publicJobHtml({ after: '<section class="top-card-layout"><h1 class="top-card-layout__title">Other Engineer</h1><a class="topcard__org-name-link">Other Employer</a></section>' }),
    publicJobHtml({ after: '<section class="description"><div class="show-more-less-html__markup">SECOND_JOB_BODY</div></section>' })]) {
    assert.equal(api.parsePublicDescription(changed, publicIdentity), null);
  }
});

test("a closed exact public posting is marked closed without treating a login CTA as an open application", (t) => {
  const { api } = descriptionFixture(t);
  const closed = api.parsePublicDescription(publicJobHtml({ closed: true }), publicIdentity);
  assert.equal(closed.applicationsClosed, true);
  assert.match(closed.description, /Build production Java integration services/u);
  const ordinary = api.parsePublicDescription(publicJobHtml({ after: '<a href="/login">Sign in to apply</a><aside class="related-jobs"><span class="closed-job">No longer accepting applications</span></aside>' }), publicIdentity);
  assert.equal(ordinary.applicationsClosed, undefined);
  assert.equal(ordinary.applicationsAvailable, undefined);
});

test("LinkedIn title identity normalizes only Senior abbreviations and an explicitly separated leading Remote label", (t) => {
  const { api } = descriptionFixture(t);
  for (const [left, right] of [
    ['Remote-Sr Authentication / Identity Security Engineer', 'Senior Authentication / Identity Security Engineer'],
    ['REMOTE: Sr. Software Engineer', 'Senior Software Engineer'],
    ['Remote—Sr. Backend Engineer', 'Senior Backend Engineer'],
    ['Remote – Senior Engineer', 'Sr Engineer']
  ]) assert.equal(api.identityTitle(left), api.identityTitle(right), `${left} / ${right}`);
  for (const [left, right] of [
    ['Remote Sensing Engineer', 'Sensing Engineer'], ['Remote / Senior Engineer', 'Senior Engineer'],
    ['Senior Engineer - Remote', 'Senior Engineer'], ['Hybrid-Sr Engineer', 'Senior Engineer'],
    ['Staff Engineer', 'Senior Engineer'], ['Lead Software Engineer', 'Senior Software Engineer'],
    ['Senior Backend Engineer', 'Senior Frontend Engineer'], ['Senior Engineer I', 'Senior Engineer II'],
    ['SrSoftware Engineer', 'SeniorSoftware Engineer'], ['Senior A / B Engineer', 'Senior A B Engineer']
  ]) assert.notEqual(api.identityTitle(left), api.identityTitle(right), `${left} / ${right}`);
  assert.equal(api.identityTitle('Staff Engineer'), 'staff engineer');
  assert.equal(api.identityTitle('Lead Engineer'), 'lead engineer');
});

test("the same public job accepts its narrow Senior/Remote title variation and preserves the published title", (t) => {
  const { api } = descriptionFixture(t);
  const title = 'Remote-Sr Java Integration Engineer III';
  const value = api.parsePublicDescription(publicJobHtml({ title }), { ...publicIdentity, title: 'Senior Java Integration Engineer III' });
  assert.equal(value.jobId, publicIdentity.jobId);
  assert.equal(value.title, title);
  assert.match(value.description, /Build production Java integration services/u);
  for (const changed of [{ title: 'Remote-Staff Java Integration Engineer III' }, { title: 'Remote-Lead Java Integration Engineer III' },
    { title: 'Remote-Sr Frontend Engineer III' }, { company: 'Other employer' }, { headerId: '999' }]) {
    assert.equal(api.parsePublicDescription(publicJobHtml({ title, ...changed }), { ...publicIdentity, title: 'Senior Java Integration Engineer III' }), null);
  }
});
