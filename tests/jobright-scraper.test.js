const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const fixture = require("./fixtures/jobright-page.js");
function setup(t, { html = fixture.page(), url = `https://jobright.ai/jobs/info/${fixture.A}` } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" }); t.after(() => dom.window.close());
  for (const name of ["capture-policy.js", "jobright-scraper.js"]) dom.window.eval(fs.readFileSync(require.resolve(`../src/${name}`), "utf8"));
  return { api: dom.window.JobrightJobScraper, document: dom.window.document, window: dom.window };
}

function detailList(document) {
  const main = document.querySelector("#jobs-page-main-content");
  const list = document.createElement("div");
  list.className = "index_jobs-list__CM7kJ";
  list.append(document.querySelector("header"), ...main.childNodes);
  main.append(list);
  return list;
}

function concealListForDetails(list) {
  list.classList.add("index_jobs-list-leave___nSi4");
  list.setAttribute("style", "opacity:0;height:0;overflow:hidden");
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
  assert.equal(value.workplaceType, "remote"); assert.equal(value.isEasyApply, false);
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
test("default country and other committed topbar filters do not require active state", (t) => {
  const { api, document } = setup(t);
  const active = api.searchContext();
  for (const control of document.querySelectorAll("[data-preference-key]")) control.setAttribute("data-topbar-state", "default");
  assert.equal(api.searchContext().selectedRegion, "us");
  assert.equal(api.searchContext().selectedRegionSource, "search-control");
  assert.equal(api.searchContext().filterKey, active.filterKey);
  assert.equal(api.scrape().selectedRegion, "us");
  document.querySelector("[data-preference-key='workLocation'] span").setAttribute("title", "Hybrid");
  assert.notEqual(api.searchContext().filterKey, active.filterKey);
});
test("stateless country controls are accepted only with committed topbar markers", (t) => {
  const { api, document } = setup(t);
  const country = document.querySelector("[data-preference-key='country']");
  const active = api.searchContext();
  country.removeAttribute("data-topbar-state");
  assert.equal(api.searchContext().selectedRegion, "");
  country.setAttribute("data-preference-measure", "item");
  assert.equal(api.searchContext().filterKey, active.filterKey);
  country.removeAttribute("data-preference-measure");
  country.querySelector("button").setAttribute("data-topbar-kind", "selector");
  assert.equal(api.searchContext().filterKey, active.filterKey);
  country.querySelector("button").removeAttribute("data-topbar-kind");
  country.querySelector("span").className = "TopbarButton_topbar-button-value__wVW9O";
  assert.equal(api.searchContext().filterKey, active.filterKey);
});
test("country value ignores setting icons and duplicate nested label titles", (t) => {
  const { api, document } = setup(t);
  const active = api.searchContext();
  const button = document.querySelector("[data-preference-key='country'] button");
  button.innerHTML = '<span class="TopbarButton_topbar-button-value__value" title="United States"><span title="United States">United States</span></span><span title="setting"><svg aria-label="setting"><title>setting</title></svg></span>';
  assert.equal(api.searchContext().selectedRegion, "us");
  assert.equal(api.searchContext().filterKey, active.filterKey);
  button.innerHTML = 'United States <svg aria-label="setting"><title>setting</title></svg>';
  assert.equal(api.searchContext().filterKey, active.filterKey);
});
test("draft country controls cannot override the committed non-US country", (t) => {
  const { api, document } = setup(t);
  const country = document.querySelector("[data-preference-key='country'] span");
  country.setAttribute("title", "United Kingdom");
  country.textContent = "United Kingdom";
  const committed = api.searchContext().filterKey;
  for (const role of ["dialog", "listbox", "menu"]) {
    document.body.insertAdjacentHTML("beforeend", `<div role="${role}"><div data-preference-key="country" data-topbar-state="active"><button data-topbar-kind="selector"><span title="United States">United States</span></button></div></div>`);
  }
  document.body.insertAdjacentHTML("beforeend", '<div class="ant-popover"><div data-preference-key="country" data-topbar-state="default"><button><span title="United States">United States</span></button></div></div><input value="United States">');
  assert.equal(api.searchContext().filterKey, committed);
  assert.equal(api.searchContext().selectedRegion, "");
  assert.throws(() => api.scrape(), /Select United States/u);
});
test("hidden or measurement country clones cannot override a visible committed filter", (t) => {
  const { api, document } = setup(t);
  const active = api.searchContext();
  for (const attributes of ['hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"', 'data-preference-measure="measurement"']) {
    document.body.insertAdjacentHTML("beforeend", `<div data-preference-key="country" data-topbar-state="default" ${attributes}><button data-topbar-kind="selector"><span title="United Kingdom">United Kingdom</span></button></div>`);
  }
  assert.equal(api.searchContext().filterKey, active.filterKey);
});

test("opening a Jobright detail preserves the mounted search filters and card identities", (t) => {
  const { api, document } = setup(t, { html: fixture.page([fixture.job(), fixture.job(fixture.B)]) });
  const list = detailList(document);
  const before = api.searchContext();
  const beforeCards = Array.from(api.cards(), (record) => record.identity);
  concealListForDetails(list);
  const after = api.searchContext();
  assert.equal(after.filterKey, before.filterKey, "the detail transition is not a search change");
  assert.equal(after.selectedRegion, "us");
  assert.equal(after.selectedRegionSource, "search-control");
  assert.deepEqual(Array.from(api.cards(), (record) => record.identity), beforeCards);
  const captured = api.scrape();
  assert.equal(captured.jobId, fixture.A);
  assert.equal(captured.title, "Software Engineer 1");
  assert.equal(captured.company, "Company 1");
  assert.equal(captured.searchContextKey, before.filterKey);
  assert.equal(captured.selectedRegion, "us");
  assert.match(captured.description, /5\+ years of software engineering/u);
});

test("actual committed filter changes remain detectable behind a Jobright detail", (t) => {
  const { api, document } = setup(t);
  const list = detailList(document);
  const before = api.searchContext().filterKey;
  concealListForDetails(list);
  document.querySelector("[data-preference-key='workLocation'] span").setAttribute("title", "Hybrid");
  assert.notEqual(api.searchContext().filterKey, before);
  const country = document.querySelector("[data-preference-key='country'] span");
  country.setAttribute("title", "United Kingdom");
  country.textContent = "United Kingdom";
  const changed = api.searchContext();
  assert.notEqual(changed.filterKey, before);
  assert.match(changed.filterKey, /United Kingdom/u);
  assert.equal(changed.selectedRegion, "");
  assert.throws(() => api.scrape(), /Select United States/u);
});

test("detail-list visibility does not admit hidden nested filter or card clones", (t) => {
  const { api, document } = setup(t);
  const list = detailList(document);
  const before = api.searchContext().filterKey;
  concealListForDetails(list);
  for (const attributes of ['hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"', 'data-preference-measure="measurement"']) {
    list.insertAdjacentHTML("beforeend", `<div data-preference-key="country" data-topbar-state="active" ${attributes}><button><span title="United Kingdom">United Kingdom</span></button></div>`);
  }
  for (const attributes of ['hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"']) {
    list.insertAdjacentHTML("beforeend", `<div ${attributes}>${fixture.card(fixture.job(fixture.B))}</div>`);
  }
  assert.equal(api.searchContext().filterKey, before);
  assert.equal(api.searchContext().selectedRegion, "us");
  assert.deepEqual(Array.from(api.cards(), (record) => record.id), [fixture.A]);
});

test("an unrelated transparent US control cannot override the retained UK filter", (t) => {
  const { api, document } = setup(t);
  const list = detailList(document);
  const country = list.querySelector("[data-preference-key='country'] span");
  country.setAttribute("title", "United Kingdom");
  country.textContent = "United Kingdom";
  const committed = api.searchContext().filterKey;
  concealListForDetails(list);
  const clone = '<div data-preference-key="country" data-topbar-state="active" style="opacity:0"><button><span title="United States">United States</span></button></div>';
  list.insertAdjacentHTML("beforeend", clone);
  document.body.insertAdjacentHTML("beforeend", clone);
  assert.equal(api.searchContext().filterKey, committed);
  assert.equal(api.searchContext().selectedRegion, "");
  assert.throws(() => api.scrape(), /Select United States/u);
});

test("the detail-list opacity exception is restricted to the observed detail route and main list", async (t) => {
  for (const scenario of ["recommend", "unsupported-route", "outside-main", "wrong-main", "not-list", "not-leaving"]) {
    await t.test(scenario, (t) => {
      const url = scenario === "recommend" ? "https://jobright.ai/jobs/recommend" : scenario === "unsupported-route" ? "https://jobright.ai/jobs/other" : `https://jobright.ai/jobs/info/${fixture.A}`;
      const { api, document } = setup(t, { url });
      const list = detailList(document);
      concealListForDetails(list);
      if (scenario === "outside-main") document.body.append(list);
      if (scenario === "wrong-main") document.querySelector("main").id = "unrelated-main-content";
      if (scenario === "not-list") list.classList.remove("index_jobs-list__CM7kJ");
      if (scenario === "not-leaving") list.classList.remove("index_jobs-list-leave___nSi4");
      assert.equal(api.searchContext().filterKey, "");
      assert.equal(api.searchContext().selectedRegion, "");
      assert.equal(api.cards().length, 0);
    });
  }
});

test("the retained list still rejects genuinely hidden ancestors", async (t) => {
  for (const attributes of ['hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"']) {
    await t.test(attributes, (t) => {
      const { api, document } = setup(t);
      const list = detailList(document);
      concealListForDetails(list);
      const wrapper = document.createElement("div");
      wrapper.innerHTML = `<div ${attributes}></div>`;
      const hidden = wrapper.firstElementChild;
      list.before(hidden);
      hidden.append(list);
      assert.equal(api.searchContext().selectedRegion, "");
      assert.equal(api.cards().length, 0);
      assert.throws(() => api.scrape(), /Select United States/u);
    });
  }
});

test("detail headings must stay visible even when mounted inside a retained list", (t) => {
  const { api, document } = setup(t);
  const list = detailList(document);
  list.append(document.querySelector("#details"));
  concealListForDetails(list);
  assert.equal(api.searchContext().selectedRegion, "us");
  assert.throws(() => api.scrape(), /details are not ready/u);
});
test("duplicate committed country values are stable but conflicting visible countries fail closed", (t) => {
  const { api, document } = setup(t);
  const active = api.searchContext();
  document.body.insertAdjacentHTML("beforeend", '<div data-preference-key="country" data-topbar-state="default"><button><span title="United States">United States</span></button></div>');
  assert.equal(api.searchContext().filterKey, active.filterKey);
  document.body.insertAdjacentHTML("afterbegin", '<div data-preference-key="country" data-topbar-state="active"><button><span title="United Kingdom">United Kingdom</span></button></div>');
  assert.equal(api.searchContext().filterKey, "");
  assert.equal(api.searchContext().selectedRegion, "");
  assert.throws(() => api.scrape(), /Select United States/u);
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

test("only the unique visible detail panel matching the requested metadata ID can be captured", (t) => {
  const { api, document } = setup(t);
  const stale = fixture.job(fixture.B, { company: "Stale Employer", title: "Stale Engineer" });
  document.querySelector("#details").insertAdjacentHTML("afterbegin", fixture.details(stale));
  const selected = api.scrape();
  assert.equal(selected.jobId, fixture.A);
  assert.equal(selected.company, "Company 1");
  assert.equal(selected.title, "Software Engineer 1");
  assert.match(selected.description, new RegExp(fixture.A, "u"));
  assert.doesNotMatch(selected.description, new RegExp(fixture.B, "u"));
  document.querySelector("#details").insertAdjacentHTML("beforeend", fixture.details(fixture.job()));
  assert.throws(() => api.scrape(), /changing|ambiguous|multiple|confirmed/iu);
});

test("multiple visible overviews in one Jobright detail cannot mix their descriptions", (t) => {
  const { api, document } = setup(t);
  const selected = document.querySelector("#overview-1");
  const duplicate = selected.cloneNode(true);
  duplicate.querySelector("span[class*='index_listText__']").textContent = "Build unrelated systems for a different posting.";
  selected.after(duplicate);
  assert.throws(() => api.scrape(), /changing|ambiguous|multiple|confirmed/iu);
  duplicate.hidden = true;
  assert.match(api.scrape().description, new RegExp(fixture.A, "u"));
  assert.doesNotMatch(api.scrape().description, /unrelated systems/u);
});

test("a nested foreign detail overview cannot be mistaken for the selected job description", (t) => {
  const { api, document } = setup(t);
  const selected = document.querySelector(".index_jobDetailContent__rhs3U");
  const foreign = document.createElement("div"); foreign.className = "index_jobDetailContent__nested";
  foreign.innerHTML = '<section id="overview-1"><h2>Responsibilities</h2><p>Build unrelated nested software for a different posting.</p></section>';
  selected.append(foreign);
  assert.throws(() => api.scrape(), /changing|ambiguous|multiple|confirmed/iu);
  foreign.hidden = true;
  assert.match(api.scrape().description, new RegExp(fixture.A, "u"));
  assert.doesNotMatch(api.scrape().description, /unrelated nested/u);
});

test("case-only differences between the selected card and rendered detail are the same job", (t) => {
  const { api, document } = setup(t);
  document.querySelector(".index_company-job__header h2").textContent = "COMPANY 1 · 5 minutes ago";
  document.querySelector("h1").textContent = "SOFTWARE ENGINEER 1";
  const value = api.scrape();
  assert.equal(value.jobId, fixture.A);
  assert.equal(value.company, "COMPANY 1");
  assert.equal(value.title, "SOFTWARE ENGINEER 1");
  document.querySelector(".index_company-job__header h2").textContent = "Different Employer · 5 minutes ago";
  assert.throws(() => api.scrape(), /still changing|identity|match/iu);
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
  assert.equal(api.scrape().isEasyApply, true);
  document.querySelector("#details").insertAdjacentHTML("beforeend", "<p>No longer accepting applications</p>");
  assert.equal(api.scrape().applicationsClosed, false, "unrelated page text is outside the selected panel");
  document.querySelector(".index_jobDetailContent__rhs3U").insertAdjacentHTML("beforeend", "<p>No longer accepting applications</p>");
  assert.equal(api.scrape().applicationsClosed, true);
});
test("Jobright keeps captured external apply links ordinary and portal references require research", (t) => {
  const { api, document } = setup(t);
  const original = document.querySelector("a[href^='https://careers']");
  const button = document.querySelector("#apply-now-button-id");
  const external = "https://bcbst.wd1.myworkdayjobs.com/external/job/USA-TN-Chattanooga-Remote/Senior-AI-Engineer_R-51142";
  original.href = external;
  for (const label of ["Apply Now", "Apply with Autofill"]) {
    button.textContent = label;
    assert.equal(api.scrape().applyUrl, external);
    assert.equal(api.scrape().isEasyApply, false);
  }
  for (const url of [`https://jobright.ai/jobs/info/${fixture.A}`, "https://www.linkedin.com/jobs/view/123", "javascript:void(0)", "http://127.0.0.1/jobs/123",
    "https://redirect.example.com/?url=" + encodeURIComponent(`https://jobright.ai/jobs/info/${fixture.A}`)]) {
    original.setAttribute("href", url);
    assert.equal(api.scrape().applyUrl, `https://jobright.ai/jobs/info/${fixture.A}`, url);
    assert.equal(api.scrape().isEasyApply, true, url);
  }
});
test("an absent Apply widget can use a safe external original, while an explicitly disabled control remains blocked", (t) => {
  const { api, document } = setup(t);
  const button = document.querySelector("#apply-now-button-id"); button.disabled = true;
  assert.equal(api.scrape().applicationsAvailable, false);
  button.remove();
  assert.equal(api.scrape().applicationsAvailable, true);
  assert.equal(api.scrape().isEasyApply, false);
  assert.equal(api.scrape().applicationsClosed, false);
  document.querySelector(".index_jobDetailContent__rhs3U").insertAdjacentHTML("beforeend", "<p>Applications are closed</p>");
  assert.equal(api.scrape().applicationsAvailable, false);
  assert.equal(api.scrape().applicationsClosed, true);
});

test("an absent Apply widget with only a missing, portal, or unsafe original stays unavailable", (t) => {
  const { api, document } = setup(t);
  document.querySelector("#apply-now-button-id").remove();
  const original = document.querySelector("a[href^='https://careers']");
  for (const url of [`https://jobright.ai/jobs/info/${fixture.A}`, "https://www.linkedin.com/jobs/view/123", "javascript:void(0)", "http://127.0.0.1/jobs/123",
    "https://careers.example.com/redirect?url=" + encodeURIComponent(`https://jobright.ai/jobs/info/${fixture.A}`)]) {
    original.setAttribute("href", url);
    const value = api.scrape();
    assert.equal(value.applicationsAvailable, false, url);
    assert.equal(value.isEasyApply, true, url);
    assert.equal(value.applyUrl, `https://jobright.ai/jobs/info/${fixture.A}`, url);
  }
  original.remove();
  assert.equal(api.scrape().applicationsAvailable, false);
  assert.equal(api.scrape().applicationsClosed, false);
});
