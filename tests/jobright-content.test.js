const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const fixture = require("./fixtures/jobright-page.js");
const collectionLocks = require("./fixtures/collection-locks.js");
function setup(t, { jobs = [fixture.job(), fixture.job(fixture.B)], autoStart = true, lazy = null, stale = false, resultsNavigation = false, hidden = false, blocked = new Set(), changedFilterAt = 0, listLeaveOnSelect = false, closeFadeDelay = 0, changedCountryInDetail = false, matchScores = false, resultsLoader = "", loaderDelay = 8000, replaceCardOnOpen = null, removeCardOnOpen = false, detailsOnOpen = null, revealError = "", locks = collectionLocks(), runId = "jobright-run" } = {}) {
  const dom = new JSDOM(fixture.page(jobs, null), { url: "https://jobright.ai/jobs/recommend", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close()); const window = dom.window, document = window.document;
  let time = 0, timerId = 0, scrollTop = 0, state = null, clickHandler;
  const timers = new Map(), captures = [], selections = [], messages = [], actions = [], detailCloses = [], resultNavigations = [];
  const removedCards = new Map();
  window.Date.now = () => time; window.Math.random = () => .5;
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, at: time + Number(delay || 0) }); return timerId; };
  window.clearTimeout = (id) => timers.delete(id); window.setInterval = () => 0; window.MutationObserver = class { observe() {} };
  Object.defineProperty(document, "hidden", { get: () => hidden });
  const listeners = [];
  const addEventListener = document.addEventListener.bind(document);
  document.addEventListener = (name, listener, options) => { if (name === "click") clickHandler = listener; addEventListener(name, listener, options); };
  Object.defineProperty(window.navigator, "locks", { value: locks });
  const scroller = document.querySelector("main");
  let list;
  if (listLeaveOnSelect) {
    // Jobright keeps the committed filters and cards mounted under its list
    // transition wrapper when the selected job's detail view covers them.
    const left = document.createElement("div"); left.className = "index_jobs-page-main-left__left";
    list = document.createElement("div"); list.className = "index_jobs-list__CM7kJ";
    list.append(document.querySelector("header"), ...scroller.childNodes);
    left.append(list); scroller.append(left);
  }
  Object.defineProperties(scroller, { scrollTop: { get: () => scrollTop }, clientHeight: { get: () => 300 }, scrollHeight: { get: () => 700 } });
  scroller.scrollTo = ({ top }) => {
    if (listLeaveOnSelect && window.location.pathname.startsWith("/jobs/info/")) actions.push("scroll-detail");
    scrollTop = top;
    if (lazy && top >= 400) {
      const next = lazy; lazy = null;
      const loader = resultsLoader ? document.createElement("div") : null;
      if (loader) {
        if (resultsLoader === "busy") loader.setAttribute("aria-busy", "true");
        else loader.setAttribute("role", "progressbar");
        (list || scroller).append(loader);
      }
      if (loaderDelay !== Infinity) window.setTimeout(() => {
        loader?.remove(); jobs.push(next); (list || scroller).insertAdjacentHTML("beforeend", fixture.card(next)); wire();
      }, loader ? loaderDelay : 1200);
    }
  };
  window.HTMLElement.prototype.scrollIntoView = function () {
    if (revealError) throw new Error(revealError);
    if (listLeaveOnSelect && window.location.pathname.startsWith("/jobs/info/")) actions.push("reveal-detail");
    scrollTop = 0;
  };
  const wired = new WeakSet();
  function wire() {
    for (const card of document.querySelectorAll(".job-card-flag-classname")) {
      if (wired.has(card)) continue; wired.add(card);
      if (matchScores) card.insertAdjacentHTML("beforeend", '<div class="ant-progress" role="progressbar" aria-valuenow="95" aria-valuemin="0" aria-valuemax="100"><span>95%</span></div>');
      for (const button of card.querySelectorAll("button")) button.addEventListener("click", () => actions.push(button.dataset.action));
      card.querySelector("a").addEventListener("click", (event) => {
        event.preventDefault(); const value = jobs.find((item) => item.id === card.id); selections.push(value.id);
        window.history.replaceState({}, "", `/jobs/info/${value.id}`);
        if (list) { list.classList.add("index_jobs-list-leave___nSi4"); list.style.opacity = "0"; }
        const missingDetails = typeof stale === "function" ? stale(value, selections.length) : stale;
        if (!missingDetails) window.setTimeout(() => {
          const details = document.querySelector("#details"); details.innerHTML = fixture.details(value);
          if (detailsOnOpen) detailsOnOpen(details, value, selections.length);
          if (replaceCardOnOpen) {
            const replacement = document.createElement("template"); replacement.innerHTML = fixture.card(replaceCardOnOpen(value));
            card.replaceWith(replacement.content.firstElementChild); wire();
          }
          if (typeof removeCardOnOpen === "function" ? removeCardOnOpen(value, selections.length) : removeCardOnOpen) {
            const selected = document.getElementById(value.id);
            if (selected) { removedCards.set(value.id, { value, parent: selected.parentElement, next: selected.nextElementSibling }); selected.remove(); }
          }
        }, 450);
        if (changedCountryInDetail && selections.length === 1) window.setTimeout(() => {
          const country = document.querySelector("[data-preference-key='country'] span");
          country.setAttribute("title", "United Kingdom"); country.textContent = "United Kingdom";
        }, 1500);
      });
    }
  }
  function restoreResults() {
    window.history.replaceState({}, "", "/jobs/recommend");
    document.querySelector("#details").replaceChildren();
    for (const [id, removed] of removedCards) {
      if (!document.getElementById(id)) {
        const replacement = document.createElement("template"); replacement.innerHTML = fixture.card(removed.value);
        removed.parent.insertBefore(replacement.content.firstElementChild, removed.next?.isConnected ? removed.next : null);
      }
    }
    removedCards.clear(); wire();
    if (list) {
      list.classList.remove("index_jobs-list-leave___nSi4");
      if (!closeFadeDelay) list.style.removeProperty("opacity");
      else if (closeFadeDelay !== Infinity) window.setTimeout(() => list.style.removeProperty("opacity"), closeFadeDelay);
    }
  }
  document.querySelector("#details").addEventListener("click", (event) => {
    if (event.target.id !== "job-detail-close-button") return;
    detailCloses.push(window.location.pathname.split("/").at(-1));
    restoreResults();
  });
  if (resultsNavigation) {
    const results = document.createElement("a"); results.href = "/jobs/recommend"; results.textContent = "Recommended jobs";
    results.addEventListener("click", event => { event.preventDefault(); resultNavigations.push(window.location.pathname); restoreResults(); });
    document.body.prepend(results);
  }
  wire();
  window.chrome = { runtime: { getManifest() { return { version: "0.8.6" }; }, onMessage: { addListener(listener) { listeners.push(listener); } }, async sendMessage(value) {
    messages.push(structuredClone(value));
    if (value.type === "KAI_TRACKER_RUN_STATE") return { ok: true, result: { state: structuredClone(state) } };
    if (value.type === "KAI_TRACKER_RUN_WAIT") return new Promise((resolve) => { window.setTimeout(() => resolve({ ok: true, result: { stopped: state?.id !== value.runId } }), value.milliseconds); });
    if (value.type === "KAI_TRACKER_RUN_CHECKPOINT") { if (state?.id === value.runId) state = structuredClone(value.state); return { ok: true, result: { stopped: state?.id !== value.runId } }; }
    if (value.type === "KAI_TRACKER_RUN_END") { if (state?.id === value.runId) state = null; return { ok: true, result: {} }; }
    if (value.type === "KAI_TRACKER_CLASSIFY_COMPANIES") return { ok: true, result: { companies: value.companies.map((company) => ({ company, banned: blocked.has(company), duplicate: false })) } };
    if (value.type === "KAI_TRACKER_CAPTURE") { captures.push(structuredClone(value)); return { ok: true, result: { status: "researching" } }; }
    if (value.type === "KAI_TRACKER_NOT_SAVED") return { ok: true, result: { reported: true } };
    throw new Error(`Unexpected message ${value.type}`);
  } } };
  for (const file of ["capture-policy.js", "jobright-scraper.js", "job-collector.js"]) window.eval(fs.readFileSync(require.resolve(`../src/${file}`), "utf8"));
  function newState() { return { id: runId, searchKey: window.LinkedInJobCollector.searchKey(window.location.href), filterKey: window.JobrightJobScraper.searchContext().filterKey, visited: [], pages: [], counts: {} }; }
  if (autoStart) state = newState();
  window.eval(fs.readFileSync(require.resolve("../src/jobright-content.js"), "utf8"));
  if (changedFilterAt) window.setTimeout(() => document.querySelector("[data-preference-key='workLocation'] span").setAttribute("title", "Hybrid"), changedFilterAt);
  return { document, window, messages, captures, selections, actions, detailCloses, resultNavigations,
    get state() { return state; },
    click(target) { clickHandler({ target, isTrusted: true, button: 0, defaultPrevented: false }); },
    async request(value) { return new Promise((resolve) => listeners[0](value, {}, resolve)); },
    async start() { state = newState(); return this.request({ type: "KAI_TRACKER_RUN_START", state }); },
    async advance(amount) {
      const until = time + amount; await new Promise((resolve) => setImmediate(resolve));
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break; timers.delete(next[0]); time = next[1].at; next[1].callback(); await new Promise((resolve) => setImmediate(resolve));
      }
      time = until;
    }
  };
}
test("Jobright infinite collection captures exact loaded jobs in background and leaves native controls untouched", async (t) => {
  const h = setup(t, { hidden: true, lazy: fixture.job("68c123456789abcdef012303") });
  await h.advance(180_000);
  assert.deepEqual(h.captures.map((capture) => capture.job.jobId), [fixture.A, fixture.B, "68c123456789abcdef012303"]);
  assert.deepEqual(h.selections, [fixture.A, fixture.B, "68c123456789abcdef012303"]);
  assert.ok(h.captures.every((capture) => capture.runId === "jobright-run" && capture.job.selectedRegion === "us"));
  assert.deepEqual(h.actions, []); assert.equal(h.state, null);
});

test("opening Jobright details preserves the committed US search through the list leave transition", async (t) => {
  const last = "68c123456789abcdef012303";
  const h = setup(t, { listLeaveOnSelect: true, lazy: fixture.job(last) });
  const committed = h.window.JobrightJobScraper.searchContext().filterKey;
  await h.advance(180_000);
  assert.deepEqual(h.captures.map((capture) => capture.job.jobId), [fixture.A, fixture.B, last]);
  assert.deepEqual(h.selections, [fixture.A, fixture.B, last]);
  assert.deepEqual(h.detailCloses, [fixture.A, fixture.B, last]);
  assert.ok(h.captures.every((capture) => capture.job.selectedRegion === "us" &&
    capture.job.selectedRegionSource === "search-control" && capture.job.searchContextKey === committed));
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

test("React replacing a selected Jobright card with the same job does not lose its capture", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, replaceCardOnOpen: value => ({ ...value }) });
  const original = h.document.querySelector(".job-card-flag-classname");
  await h.advance(180_000);
  assert.equal(original.isConnected, false, "selection replaces the actual card node");
  assert.notEqual(h.document.querySelector(".job-card-flag-classname"), original);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B]);
  assert.deepEqual(h.selections, [fixture.A, fixture.B]);
  assert.deepEqual(h.actions, []);
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
});

test("an authorized Jobright selection can capture exact loaded details after its entire card unmounts", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, removeCardOnOpen: true });
  const original = h.document.querySelector(".job-card-flag-classname");
  await h.advance(4500);
  assert.equal(original.isConnected, false);
  assert.equal(h.document.getElementById(fixture.A), null);
  await h.advance(180_000);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
  assert.equal(h.captures[0].job.company, "Company 1");
  assert.equal(h.captures[0].job.title, "Software Engineer 1");
  assert.equal(h.captures[0].job.selectedRegion, "us");
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

for (const failure of ["wrong metadata", "stale job detail", "missing description"]) test(`an unmounted Jobright card cannot authorize ${failure}`, async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, removeCardOnOpen: true,
    detailsOnOpen(details) {
      if (failure === "wrong metadata") for (const node of details.querySelectorAll("[data-time-filter-job]")) node.setAttribute("data-time-filter-job", fixture.B);
      else if (failure === "stale job detail") details.innerHTML = fixture.details(fixture.job(fixture.B));
      else details.querySelector("#overview-1").remove();
    } });
  await h.advance(95_000);
  assert.equal(h.captures.length, 0);
  assert.deepEqual(h.selections, [fixture.A, fixture.A], "one readiness window permits only one pre-capture reopening");
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false, "the bounded second wait has not expired");
  await h.advance(95_000);
  assert.equal(h.captures.length, 0);
  const reports = h.messages.filter(message => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(reports.length, 1);
  const report = reports[0];
  assert.equal(report?.job.jobId, fixture.A);
  assert.equal(report?.reasonCode, "DETAILS_NOT_CONFIRMED");
  assert.equal(report?.job.trackerVersion, "0.8.6");
  assert.ok(report.job.verificationReason.length > 0 && report.job.verificationReason.length <= 2000);
  assert.match(report.job.verificationReason, /180-second/);
  assert.deepEqual(h.selections, [fixture.A, fixture.A], "readiness expiry never creates another retry");
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

test("an unmounted selected Jobright card cannot bypass a committed country change", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, removeCardOnOpen: true, changedCountryInDetail: true });
  await h.advance(4500);
  assert.equal(h.document.getElementById(fixture.A), null);
  await h.advance(80_000);
  assert.equal(h.captures.length, 0);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

test("one bounded Jobright detail retry rebinds a fresh same-job card before the single capture", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, replaceCardOnOpen: value => ({ ...value }),
    detailsOnOpen(details, _value, opens) {
      if (opens === 1) for (const node of details.querySelectorAll("[data-time-filter-job]")) node.setAttribute("data-time-filter-job", fixture.B);
    } });
  const original = h.document.querySelector(".job-card-flag-classname");
  await h.advance(180_000);
  assert.equal(original.isConnected, false);
  assert.deepEqual(h.selections, [fixture.A, fixture.A]);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
  assert.deepEqual(h.actions, []);
});

for (const invalid of ["duplicate selected card", "duplicate selected ID with a different employer", "changed linked job ID"]) test(`a present ${invalid} cannot use the absent-card detail authority`, async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true,
    detailsOnOpen(details, value) {
      const card = details.ownerDocument.getElementById(value.id);
      if (invalid.startsWith("duplicate")) {
        const duplicate = card.cloneNode(true);
        if (invalid.includes("different employer")) duplicate.querySelector("[class*='index_company-name__']").textContent = "Different Employer";
        card.after(duplicate);
      }
      else card.querySelector("a").href = `/jobs/info/${fixture.B}`;
    } });
  await h.advance(180_000);
  assert.equal(h.captures.length, 0);
  const report = h.messages.find(message => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(report?.reasonCode, "DETAILS_NOT_CONFIRMED");
  assert.equal(report?.job.jobId, fixture.A);
  assert.ok(report.job.verificationReason.length > 0);
  assert.deepEqual(h.actions, []);
});

for (const changed of [{ company: "Different Employer" }, { title: "Different Vacancy" }]) test(`a replacement card with a changed ${Object.keys(changed)[0]} cannot authorize the original capture`, async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, replaceCardOnOpen: value => ({ ...value, ...changed }) });
  await h.advance(180_000);
  assert.equal(h.captures.length, 0);
  const report = h.messages.find(message => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(report?.job.jobId, fixture.A);
  assert.equal(report?.reasonCode, "DETAILS_NOT_CONFIRMED");
  assert.deepEqual(h.actions, []);
});

test("case-only company and title changes in a replacement card and its detail retain the same job", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true,
    replaceCardOnOpen: value => ({ ...value, company: value.company.toUpperCase(), title: value.title.toUpperCase() }),
    detailsOnOpen(details) {
      details.querySelector("h1").textContent = "SOFTWARE ENGINEER 1";
      details.querySelector(".index_company-job__header h2").textContent = "COMPANY 1 · 5 minutes ago";
    } });
  await h.advance(180_000);
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].job.jobId, fixture.A);
  assert.equal(h.captures[0].job.company.toLowerCase(), "company 1");
  assert.equal(h.captures[0].job.title.toLowerCase(), "software engineer 1");
  assert.deepEqual(h.actions, []);
});

test("a verified external original job remains collectible when Jobright's Apply widget is absent", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], detailsOnOpen(details) { details.querySelector("#apply-now-button-id").remove(); } });
  await h.advance(180_000);
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].job.jobId, fixture.A);
  assert.equal(h.captures[0].job.isEasyApply, false);
  assert.equal(h.captures[0].job.applicationsAvailable, true);
  assert.equal(h.captures[0].job.applyUrl, `https://careers.example.com/${fixture.A}`);
  assert.deepEqual(h.actions, []);
});

test("a portal fallback with no Apply widget cannot reach downstream capture", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], detailsOnOpen(details) {
    details.querySelector("#apply-now-button-id").remove();
    details.querySelector("a[href^='https://careers']").remove();
  } });
  await h.advance(95_000);
  assert.equal(h.captures.length, 0);
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
  assert.deepEqual(h.selections, [fixture.A, fixture.A]);
  await h.advance(95_000);
  assert.equal(h.captures.length, 0);
  const reports = h.messages.filter(message => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reasonCode, "DETAILS_NOT_CONFIRMED");
  assert.match(reports[0].job.verificationReason, /application control|Apply/);
  assert.match(reports[0].job.verificationReason, /180-second/);
  assert.deepEqual(h.actions, []);
});

test("a Jobright detail that fails to render initially can reopen once and queue the verified job", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, resultsNavigation: true, stale: (_value, opens) => opens === 1 });
  await h.advance(180_000);
  assert.deepEqual(h.selections, [fixture.A, fixture.A]);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
  assert.deepEqual(h.resultNavigations, [`/jobs/info/${fixture.A}`]);
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

test("a permanently missing Jobright detail is reported after bounded recovery and the next job can queue", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, resultsNavigation: true, stale: value => value.id === fixture.A });
  await h.advance(95_000);
  assert.deepEqual(h.selections, [fixture.A, fixture.A]);
  assert.equal(h.captures.length, 0);
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
  await h.advance(130_000);
  assert.deepEqual(h.selections, [fixture.A, fixture.A, fixture.B]);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.B]);
  const reports = h.messages.filter(message => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].job.jobId, fixture.A);
  assert.equal(reports[0].reasonCode, "DETAILS_NOT_CONFIRMED");
  assert.match(reports[0].job.verificationReason, /180-second/);
  assert.deepEqual(h.resultNavigations, [`/jobs/info/${fixture.A}`, `/jobs/info/${fixture.A}`]);
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

test("Jobright waits for the result list to fade back in after the detail route closes", async (t) => {
  const last = "68c123456789abcdef012303";
  const h = setup(t, { listLeaveOnSelect: true, closeFadeDelay: 450, lazy: fixture.job(last) });
  const committed = h.window.JobrightJobScraper.searchContext().filterKey;
  await h.advance(180_000);
  assert.deepEqual(h.captures.map((capture) => capture.job.jobId), [fixture.A, fixture.B, last]);
  assert.deepEqual(h.selections, [fixture.A, fixture.B, last]);
  assert.deepEqual(h.detailCloses, [fixture.A, fixture.B, last]);
  assert.ok(h.captures.every((capture) => capture.job.searchContextKey === committed && capture.job.selectedRegion === "us"));
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

test("Jobright stops after a bounded wait when the closed detail never restores the result list", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeFadeDelay: Infinity });
  for (let elapsed = 0; elapsed < 60_000 && !h.detailCloses.length; elapsed += 1000) await h.advance(1000);
  assert.deepEqual(h.detailCloses, [fixture.A]);
  await h.advance(1000);
  assert.ok(h.state, "the closing transition must have time to restore the verified search");
  await h.advance(20_000);
  assert.deepEqual(h.captures.map((capture) => capture.job.jobId), [fixture.A]);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

test("Jobright match-score progressbars do not block lazy loading or completion", async (t) => {
  const last = "68c123456789abcdef012303";
  const h = setup(t, { listLeaveOnSelect: true, matchScores: true, lazy: fixture.job(last) });
  await h.advance(180_000);
  assert.deepEqual(h.captures.map((capture) => capture.job.jobId), [fixture.A, fixture.B, last]);
  assert.deepEqual(h.selections, [fixture.A, fixture.B, last]);
  assert.deepEqual(h.detailCloses, [fixture.A, fixture.B, last]);
  assert.equal(h.document.querySelectorAll("[role='progressbar'][aria-valuenow='95']").length, 3);
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

for (const resultsLoader of ["busy", "indeterminate"]) test(`Jobright waits for a genuine ${resultsLoader} results loader before collecting the next jobs`, async (t) => {
  const last = "68c123456789abcdef012303";
  const h = setup(t, { listLeaveOnSelect: true, lazy: fixture.job(last), resultsLoader, loaderDelay: 8000 });
  await h.advance(180_000);
  assert.deepEqual(h.captures.map((capture) => capture.job.jobId), [fixture.A, fixture.B, last]);
  assert.deepEqual(h.selections, [fixture.A, fixture.B, last]);
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

test("Jobright stops waiting when a genuine results loader never settles", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, lazy: fixture.job("68c123456789abcdef012303"), resultsLoader: "indeterminate", loaderDelay: Infinity });
  for (let elapsed = 0; elapsed < 60_000 && !h.document.querySelector("[role='progressbar']:not([aria-valuenow])"); elapsed += 1000) await h.advance(1000);
  assert.ok(h.document.querySelector("[role='progressbar']:not([aria-valuenow])"));
  await h.advance(5000);
  assert.ok(h.state, "a genuine loader must not be mistaken for the end of results");
  await h.advance(65_000);
  assert.deepEqual(h.captures.map((capture) => capture.job.jobId), [fixture.A, fixture.B]);
  assert.deepEqual(h.selections, [fixture.A, fixture.B]);
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});

test("a country change under Jobright's detail transition stops before saving the reviewed job", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, changedCountryInDetail: true });
  await h.advance(80_000);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.captures.length, 0);
  assert.equal(h.state, null);
  assert.deepEqual(h.actions, []);
});

test("stopping while Jobright details cover the results prevents capture and further navigation", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true });
  await h.advance(4500);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.document.querySelector("[class*='index_jobs-list-leave__']")?.style.opacity, "0");
  await h.request({ type: "KAI_TRACKER_RUN_STOP" });
  await h.advance(80_000);
  assert.equal(h.captures.length, 0);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.deepEqual(h.detailCloses, []);
  assert.deepEqual(h.actions, []);
  assert.equal(h.state, null);
});
test("independent Jobright runs can collect in background on the same origin", async (t) => {
  const locks = collectionLocks();
  const first = setup(t, { jobs: [fixture.job()], hidden: true, locks, runId: "first-run" });
  const second = setup(t, { jobs: [fixture.job(fixture.B)], hidden: true, locks, runId: "second-run" });
  await first.advance(1000); await second.advance(1000);
  assert.deepEqual(locks.heldNames.sort(), ["job-tracker-collection:first-run", "job-tracker-collection:second-run"]);
  assert.ok(locks.requests.every((request) => request.ifAvailable === true));
  await first.advance(180_000); await second.advance(180_000);
  assert.deepEqual(first.captures.map((capture) => capture.job.jobId), [fixture.A]);
  assert.deepEqual(second.captures.map((capture) => capture.job.jobId), [fixture.B]);
  assert.equal(locks.acquired, 2); assert.equal(locks.released, 2); assert.equal(locks.held, false);
});
test("a replacement Jobright document cannot collect or end an owned run and resumes after release", async (t) => {
  const locks = collectionLocks();
  const first = setup(t, { jobs: [fixture.job()], locks, runId: "same-run" }); await first.advance(1000);
  const replacement = setup(t, { jobs: [fixture.job(fixture.B)], locks, runId: "same-run" }); await replacement.advance(1000);
  assert.equal(replacement.captures.length, 0); assert.equal(replacement.selections.length, 0);
  assert.equal(replacement.messages.some((message) => message.type === "KAI_TRACKER_RUN_END"), false);
  assert.deepEqual(locks.heldNames, ["job-tracker-collection:same-run"]);
  await first.advance(180_000); assert.equal(locks.held, false);
  const resumed = replacement.start(); await replacement.advance(0); await resumed; await replacement.advance(180_000);
  assert.deepEqual(replacement.captures.map((capture) => capture.job.jobId), [fixture.B]);
  assert.equal(locks.acquired, 2); assert.equal(locks.released, 2); assert.equal(locks.held, false);
});
test("changing committed filters stops before capture", async (t) => {
  const h = setup(t, { changedFilterAt: 3000 }); await h.advance(40_000);
  assert.equal(h.captures.length, 0); assert.equal(h.state, null);
});
test("unconfirmed stale details are reported and never saved", async (t) => {
  const h = setup(t, { stale: true, jobs: [fixture.job()] }); await h.advance(80_000);
  assert.equal(h.captures.length, 0);
  assert.equal(h.messages.some(value => value.type === "KAI_TRACKER_NOT_SAVED"), false);
  await h.advance(20_000);
  const report = h.messages.find((value) => value.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(report.reasonCode, "DETAILS_NOT_CONFIRMED"); assert.equal(report.job.jobId, fixture.A);
  assert.match(report.reasonDetail, /details.*(?:not ready|changing|could not|unavailable)|detail view could not be closed/iu);
  assert.ok(report.reasonDetail.length <= 2000);
  assert.match(report.reasonDetail, /90-second/);
  assert.equal(report.job.detailAvailability, "unavailable");
  assert.deepEqual(h.selections, [fixture.A], "without a safe return control no second selection is attempted");
});
test("collector failure details preserve the actual cause and cap diagnostic text at 2000 characters", async (t) => {
  const reason = `The Jobright card could not be revealed: ${"x".repeat(2500)}`;
  const h = setup(t, { jobs: [fixture.job()], revealError: reason }); await h.advance(50_000);
  const report = h.messages.find((value) => value.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(report.reasonCode, "CARD_UNAVAILABLE"); assert.equal(report.reasonDetail, reason.slice(0, 2000));
  assert.equal(report.reasonDetail.length, 2000); assert.equal(h.captures.length, 0);
});
test("banned cards are reported without clicking any Jobright dismiss or like control", async (t) => {
  const h = setup(t, { blocked: new Set(["Company 1"]) }); await h.advance(100_000);
  assert.deepEqual(h.captures.map((value) => value.job.jobId), [fixture.B]);
  assert.deepEqual(h.actions, []);
  assert.equal(h.messages.find((value) => value.type === "KAI_TRACKER_NOT_SAVED").reasonCode, "BANNED_COMPANY");
});
test("manual capture requires trusted primary card selection and waits for exact settled details", async (t) => {
  const h = setup(t, { autoStart: false, jobs: [fixture.job()] }); const card = h.document.querySelector(".job-card-flag-classname");
  for (const target of [...card.querySelectorAll("button"), card.querySelector("[data-match]")]) h.click(target);
  await h.advance(3000); assert.equal(h.captures.length, 0);
  h.click(card.querySelector("h2")); card.querySelector("a").click();
  await h.advance(3000); assert.equal(h.captures.length, 1); assert.equal(h.captures[0].runId, undefined);
  assert.equal(h.captures[0].job.jobId, fixture.A);
});
test("a trusted manual Jobright selection waits for exact details after its card unmounts", async (t) => {
  const h = setup(t, { autoStart: false, jobs: [fixture.job()] });
  const card = h.document.querySelector(".job-card-flag-classname");
  h.click(card.querySelector("h2")); card.querySelector("a").click(); card.remove();
  await h.advance(200);
  assert.equal(h.captures.length, 0, "unmounting the card does not make unfinished details ready");
  await h.advance(3000);
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].runId, undefined);
  assert.equal(h.captures[0].job.jobId, fixture.A);
  assert.equal(h.captures[0].job.company, "Company 1");
  assert.equal(h.captures[0].job.title, "Software Engineer 1");
  assert.deepEqual(h.actions, []);
});

for (const failure of ["wrong metadata", "missing description"]) test(`a trusted manual selection with an unmounted card rejects ${failure}`, async (t) => {
  const h = setup(t, { autoStart: false, jobs: [fixture.job()], detailsOnOpen(details) {
    if (failure === "wrong metadata") for (const node of details.querySelectorAll("[data-time-filter-job]")) node.setAttribute("data-time-filter-job", fixture.B);
    else details.querySelector("#overview-1").remove();
  } });
  const card = h.document.querySelector(".job-card-flag-classname");
  h.click(card.querySelector("h2")); card.querySelector("a").click(); card.remove();
  await h.advance(16_000);
  assert.equal(h.captures.length, 0);
  assert.equal(h.messages.find(message => message.type === "KAI_TRACKER_NOT_SAVED")?.job.jobId, fixture.A);
  assert.deepEqual(h.actions, []);
});

test("manual popup scraping and search context use the same verified adapter", async (t) => {
  const h = setup(t, { autoStart: false, jobs: [fixture.job()] });
  assert.equal((await h.request({ type: "SCRAPE_LINKEDIN_JOB" })).ok, false);
  h.document.querySelector(".job-card-flag-classname a").click(); await h.advance(1000);
  assert.equal((await h.request({ type: "SCRAPE_LINKEDIN_JOB" })).data.jobId, fixture.A);
  const response = await h.request({ type: "KAI_TRACKER_SEARCH_CONTEXT" }); assert.equal(response.result.selectedRegion, "us"); assert.ok(response.result.filterKey);
});
