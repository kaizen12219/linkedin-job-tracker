const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const fixture = require("./fixtures/jobright-page.js");
const collectionLocks = require("./fixtures/collection-locks.js");
function setup(t, { jobs = [fixture.job(), fixture.job(fixture.B)], autoStart = true, lazy = null, lazyDelay = 1200, lazyBatches = null, initialScrollHeight = 700, stale = false, resultsNavigation = false, hidden = false, blocked = new Set(), changedFilterAt = 0, listLeaveOnSelect = false, initialListDelay = 0, closeFadeDelay = 0, closeBehavior = "restore", afterClose = null, changedCountryInDetail = false, matchScores = false, resultsLoader = "", loaderDelay = 8000, replaceCardOnOpen = null, removeCardOnOpen = false, detailsOnOpen = null, revealError = "", locks = collectionLocks(), runId = "jobright-run" } = {}) {
  const dom = new JSDOM(fixture.page(jobs, null), { url: "https://jobright.ai/jobs/recommend", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close()); const window = dom.window, document = window.document;
  let time = 0, timerId = 0, scrollTop = 0, scrollHeight = initialScrollHeight, batchIndex = 0, pendingBatch = false, state = null, clickHandler;
  const timers = new Map(), captures = [], selections = [], messages = [], actions = [], detailCloses = [], closeAttempts = [], resultNavigations = [], resultNavigationTimes = [];
  const scrollAttempts = [], batchArrivals = [], runEnds = [], detailCloseTimes = [];
  const batches = lazyBatches || (lazy ? [{ job: lazy, delay: resultsLoader ? loaderDelay : lazyDelay }] : []);
  const removedCards = new Map();
  let detachedHeader = null;
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
    if (initialListDelay) {
      document.body.prepend(list.querySelector("header"));
      list.classList.add("index_jobs-list-leave___nSi4"); list.style.opacity = "0";
      window.setTimeout(() => { list.classList.remove("index_jobs-list-leave___nSi4"); list.style.removeProperty("opacity"); }, initialListDelay);
    }
  }
  Object.defineProperties(scroller, { scrollTop: { get: () => scrollTop }, clientHeight: { get: () => 300 }, scrollHeight: { get: () => scrollHeight } });
  scroller.scrollTo = ({ top }) => {
    if (listLeaveOnSelect && window.location.pathname.startsWith("/jobs/info/")) actions.push("scroll-detail");
    scrollTop = Math.max(0, Math.min(top, scrollHeight - 300));
    scrollAttempts.push({ top: scrollTop, at: time, height: scrollHeight });
    if (!pendingBatch && batchIndex < batches.length && scrollTop >= Math.max(0, scrollHeight - 300)) {
      const batch = batches[batchIndex++], next = batch.job;
      pendingBatch = true;
      const loader = resultsLoader ? document.createElement("div") : null;
      if (loader) {
        if (resultsLoader === "busy") loader.setAttribute("aria-busy", "true");
        else loader.setAttribute("role", "progressbar");
        (list || scroller).append(loader);
      }
      if (batch.delay !== Infinity) window.setTimeout(() => {
        loader?.remove(); pendingBatch = false; jobs.push(next);
        if (lazyBatches) scrollHeight = batch.height ?? scrollHeight + 400;
        (list || scroller).insertAdjacentHTML("beforeend", fixture.card(next)); wire();
        batchArrivals.push({ id: next.id, at: time, height: scrollHeight });
      }, batch.delay);
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
          for (const button of details.querySelectorAll("button[id*='job-detail-close-button']")) {
            const click = button.click.bind(button);
            button.click = () => { closeAttempts.push({ id: button.id, at: time }); click(); };
          }
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
    if (detachedHeader) { (list || document.body).prepend(detachedHeader); detachedHeader = null; }
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
    const closedId = window.location.pathname.split("/").at(-1);
    detailCloses.push(closedId);
    detailCloseTimes.push({ id: closedId, at: time });
    if (closeBehavior === "restore") restoreResults();
    else if (closeBehavior === "route-only") window.history.replaceState({}, "", "/jobs/recommend");
    else if (closeBehavior === "filters-missing") {
      restoreResults();
      detachedHeader = document.querySelector("header"); detachedHeader.remove();
    }
    if (afterClose) afterClose(document, closedId, detailCloses.length);
  });
  if (resultsNavigation) {
    const results = document.createElement("a"); results.href = typeof resultsNavigation === "string" ? resultsNavigation : "/jobs/recommend"; results.textContent = "Recommended jobs";
    results.addEventListener("click", event => { event.preventDefault(); resultNavigations.push(window.location.pathname); resultNavigationTimes.push(time); restoreResults(); });
    document.body.prepend(results);
  }
  wire();
  window.chrome = { runtime: { getManifest() { return { version: "0.8.6" }; }, onMessage: { addListener(listener) { listeners.push(listener); } }, async sendMessage(value) {
    messages.push(structuredClone(value));
    if (value.type === "KAI_TRACKER_RUN_STATE") return { ok: true, result: { state: structuredClone(state) } };
    if (value.type === "KAI_TRACKER_RUN_WAIT") return new Promise((resolve) => { window.setTimeout(() => resolve({ ok: true, result: { stopped: state?.id !== value.runId } }), value.milliseconds); });
    if (value.type === "KAI_TRACKER_RUN_CHECKPOINT") { if (state?.id === value.runId) state = structuredClone(value.state); return { ok: true, result: { stopped: state?.id !== value.runId } }; }
    if (value.type === "KAI_TRACKER_RUN_END") { runEnds.push({ at: time, ...structuredClone(value) }); if (state?.id === value.runId) state = null; return { ok: true, result: {} }; }
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
  return { document, window, messages, captures, selections, actions, detailCloses, closeAttempts, resultNavigations, resultNavigationTimes, scrollAttempts, batchArrivals, runEnds, detailCloseTimes,
    get now() { return time; },
    jump(amount) { time += amount; },
    get state() { return state; },
    click(target) { clickHandler({ target, isTrusted: true, button: 0, defaultPrevented: false }); },
    async request(value) { return new Promise((resolve) => listeners[0](value, {}, resolve)); },
    async start() { state = newState(); return this.request({ type: "KAI_TRACKER_RUN_START", state }); },
    async advance(amount) {
      const until = time + amount; await new Promise((resolve) => setImmediate(resolve));
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break; timers.delete(next[0]); time = Math.max(time, next[1].at); next[1].callback(); await new Promise((resolve) => setImmediate(resolve));
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

for (const lazyDelay of [8000, 15000]) test(`Jobright confirms the feed end long enough to collect a no-loader batch delayed ${lazyDelay} milliseconds`, async (t) => {
  const last = "68c123456789abcdef012303";
  const h = setup(t, { hidden: true, listLeaveOnSelect: true, lazy: fixture.job(last), lazyDelay });
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B, last]);
  assert.deepEqual(h.selections, [fixture.A, fixture.B, last]);
  assert.equal(h.runEnds.length, 1);
  assert.ok(h.runEnds[0].at - h.detailCloseTimes.at(-1).at >= 30_000, "completion requires a quiet confirmation after the last returned job");
  assert.equal(h.state, null);
  assert.deepEqual(h.actions, []);
});

test("Jobright probes an already-bottom short list and waits for delayed jobs without a loader", async (t) => {
  const last = "68c123456789abcdef012303";
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, initialScrollHeight: 300,
    lazy: fixture.job(last), lazyDelay: 25_000 });
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, last]);
  assert.ok(h.scrollAttempts.filter(attempt => attempt.top === 0 && attempt.at < h.batchArrivals[0].at).length >= 2,
    "a list with no scroll range still needs bottom probes while waiting for the next batch");
  assert.equal(h.runEnds.length, 1);
  assert.equal(h.state, null);
  assert.deepEqual(h.actions, []);
});

test("Jobright continues across repeated slow batches and confirms the quiet end only after the final batch", async (t) => {
  const extra = ["68c123456789abcdef012303", "68c123456789abcdef012304", "68c123456789abcdef012305"];
  const h = setup(t, { hidden: true, listLeaveOnSelect: true, lazyBatches: extra.map((id, index) => ({
    job: fixture.job(id), delay: index === 1 ? 15000 : 8000, height: 1100 + index * 400
  })) });
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B, ...extra]);
  assert.deepEqual(h.selections, [fixture.A, fixture.B, ...extra]);
  assert.deepEqual(h.batchArrivals.map(arrival => arrival.height), [1100, 1500, 1900]);
  assert.equal(h.runEnds.length, 1);
  assert.ok(h.runEnds[0].at - h.detailCloseTimes.at(-1).at >= 30_000);
  assert.equal(h.state, null);
  assert.deepEqual(h.actions, []);
});

test("Jobright's genuinely quiet feed finishes after bounded end confirmation", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true });
  for (let elapsed = 0; !h.detailCloses.length && elapsed < 60_000; elapsed += 1000) await h.advance(1000);
  assert.deepEqual(h.detailCloses, [fixture.A]);
  await h.advance(10_000);
  assert.ok(h.state, "two brief bottom observations cannot establish the true end");
  await h.advance(60_000);
  assert.equal(h.state, null);
  assert.equal(h.runEnds.length, 1);
  const quietDuration = h.runEnds[0].at - h.detailCloseTimes[0].at;
  assert.ok(quietDuration >= 30_000 && quietDuration <= 65_000, `quiet feed completed after ${quietDuration}ms`);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
});

test("Jobright does not mistake a late wake during feed-end confirmation for observed quiet time", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true });
  for (let elapsed = 0; elapsed < 60_000 && !h.document.querySelector("[data-job-tracker-collection]")?.textContent.includes("Checking for more"); elapsed += 1000) await h.advance(1000);
  assert.match(h.document.querySelector("[data-job-tracker-collection]")?.textContent || "", /Checking for more/);
  assert.ok(h.state);
  h.jump(70_000);
  await h.advance(0);
  assert.equal(h.state, null);
  const notice = h.document.querySelector("[data-job-tracker-collection]");
  assert.equal(notice?.getAttribute("role"), "alert");
  assert.match(notice?.textContent || "", /end of the list could not be confirmed within 60 seconds/);
  assert.doesNotMatch(notice?.textContent || "", /^Finished/);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.runEnds.length, 1);
});

for (const interruption of ["Stop", "filter change"]) test(`Jobright ${interruption} during feed-end confirmation prevents delayed capture`, async (t) => {
  const last = "68c123456789abcdef012303";
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, lazy: fixture.job(last), lazyDelay: 25_000 });
  for (let elapsed = 0; !h.detailCloses.length && elapsed < 60_000; elapsed += 1000) await h.advance(1000);
  await h.advance(10_000);
  assert.ok(h.state, "the run must still be confirming the feed end");
  assert.deepEqual(h.batchArrivals, []);
  if (interruption === "Stop") await h.request({ type: "KAI_TRACKER_RUN_STOP" });
  else {
    const country = h.document.querySelector("[data-preference-key='country'] span");
    country.setAttribute("title", "United Kingdom"); country.textContent = "United Kingdom";
  }
  await h.advance(120_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.runEnds.length, 1);
  assert.equal(h.state, null);
  assert.deepEqual(h.actions, []);
});

test("restarting a Jobright collector on the same page reports already submitted jobs as skipped without another capture", async (t) => {
  const h = setup(t);
  for (let elapsed = 0; !h.captures.length && elapsed < 30000; elapsed += 1000) await h.advance(1000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
  await h.request({ type: 'KAI_TRACKER_RUN_STOP' });
  await h.advance(0);
  const restarted = h.start();
  await h.advance(0); await restarted;
  await h.advance(180000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B]);
  assert.equal(h.selections.filter(id => id === fixture.A).length, 1);
  const reports = h.messages.filter(message => message.type === 'KAI_TRACKER_NOT_SAVED' && message.job.jobId === fixture.A);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reasonCode, 'ALREADY_CAPTURED');
  assert.equal(reports[0].job.verificationReason, 'Skipped: this job was already submitted from this page.');
  assert.equal(h.messages.some(message => message.type === 'KAI_TRACKER_NOT_SAVED' && message.reasonCode === 'CARD_UNAVAILABLE'), false);
  assert.deepEqual(h.actions, []);
});

test("a genuinely changed uncaptured Jobright card remains unavailable rather than already submitted", async (t) => {
  const h = setup(t);
  const sendMessage = h.window.chrome.runtime.sendMessage;
  let changed = false;
  h.window.chrome.runtime.sendMessage = async message => {
    if (!changed && message.type === 'KAI_TRACKER_CLASSIFY_COMPANIES' && message.companies.length === 1 && message.companies[0] === 'Company 1') {
      changed = true;
      h.document.getElementById(fixture.A).querySelector('h2').textContent = 'Different vacancy';
    }
    return sendMessage(message);
  };
  await h.advance(180000);
  assert.equal(changed, true);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.B]);
  const report = h.messages.find(message => message.type === 'KAI_TRACKER_NOT_SAVED' && message.job.jobId === fixture.A);
  assert.equal(report.reasonCode, 'CARD_UNAVAILABLE');
  assert.equal(h.messages.some(message => message.type === 'KAI_TRACKER_NOT_SAVED' && message.reasonCode === 'ALREADY_CAPTURED'), false);
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

for (const change of ["removed", "changed title", "ambiguous", "unusable link"]) test(`Jobright skips an unselected card ${change} while closing the prior job and continues with the next exact job`, async (t) => {
  const last = "68c123456789abcdef012303";
  const h = setup(t, { jobs: [fixture.job(), fixture.job(fixture.B), fixture.job(last)], listLeaveOnSelect: true,
    afterClose(document, closedId) {
      if (closedId !== fixture.A) return;
      const next = document.getElementById(fixture.B);
      if (change === "removed") next.remove();
      else if (change === "changed title") next.querySelector("h2").textContent = "A different vacancy";
      else if (change === "ambiguous") next.after(next.cloneNode(true));
      else next.querySelector("a").href = "https://unrelated.example/jobs/another-vacancy";
    } });
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, last]);
  assert.deepEqual(h.selections, [fixture.A, last], "the stale candidate never receives a native selection click");
  const reports = h.messages.filter(message => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].job.jobId, fixture.B); assert.equal(reports[0].reasonCode, "CARD_UNAVAILABLE");
  assert.match(reports[0].job.verificationReason, /card.*changed|unavailable|identity/iu);
  assert.ok(h.captures.every(capture => capture.job.selectedRegion === "us"));
  const checkpoint = h.messages.filter(message => message.type === "KAI_TRACKER_RUN_CHECKPOINT").at(-1);
  assert.equal(checkpoint.state.counts.skipped, 1); assert.equal(checkpoint.state.counts.researching, 2);
  assert.deepEqual(h.actions, []); assert.equal(h.state, null);
});

test("Jobright still stops if the committed country changes while closing the prior job", async (t) => {
  const last = "68c123456789abcdef012303";
  const h = setup(t, { jobs: [fixture.job(), fixture.job(fixture.B), fixture.job(last)], listLeaveOnSelect: true,
    afterClose(document, closedId) {
      if (closedId !== fixture.A) return;
      document.getElementById(fixture.B).remove();
      const country = document.querySelector("[data-preference-key='country'] span");
      country.title = "United Kingdom"; country.textContent = "United Kingdom";
    } });
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.state, null); assert.deepEqual(h.actions, []);
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
  await h.advance(45_000); // Readiness expiry is followed by the separate quiet-feed confirmation.
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
  await h.advance(45_000); // The next job is already queued; now allow the separate end confirmation.
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

test("Jobright waits beyond fifteen seconds for the original result filters to hydrate before continuing", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeFadeDelay: 20_000 });
  const committed = h.window.JobrightJobScraper.searchContext().filterKey;
  for (let elapsed = 0; elapsed < 60_000 && !h.detailCloses.length; elapsed += 1000) await h.advance(1000);
  await h.advance(16_000);
  assert.deepEqual(h.selections, [fixture.A], "a hidden result list is not ready for the next selection");
  assert.ok(h.state, "slow hydration stays within the bounded return window");
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B]);
  assert.ok(h.captures.every(capture => capture.job.searchContextKey === committed && capture.job.selectedRegion === "us"));
  assert.deepEqual(h.detailCloses, [fixture.A, fixture.B]);
  assert.equal(h.state, null);
});

test("a resumed Jobright results route waits for its collapsed list before selecting any job", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, initialListDelay: 20_000 });
  const committed = h.window.JobrightJobScraper.searchContext().filterKey;
  assert.ok(committed, "the committed country controls remain readable outside the collapsing list");
  await h.advance(16_000);
  assert.equal(h.window.location.pathname, "/jobs/recommend");
  assert.deepEqual(h.selections, []); assert.deepEqual(h.closeAttempts, []);
  assert.ok(h.state, "resuming must wait through a slow result-list transition");
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B]);
  assert.ok(h.captures.every(capture => capture.job.searchContextKey === committed));
  assert.equal(h.state, null);
});

test("Jobright can reopen exact results after the close changes route before its collapsed list restores", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeBehavior: "route-only", resultsNavigation: true });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  const closedAt = h.closeAttempts[0].at;
  assert.equal(h.window.location.pathname, "/jobs/recommend");
  assert.equal(h.window.JobrightJobScraper.searchContext().filterKey, "");
  assert.ok(h.document.querySelector("[class*='index_jobs-list-leave__']"));
  await h.advance(Math.max(0, closedAt + 4900 - h.now));
  assert.deepEqual(h.selections, [fixture.A]);
  assert.deepEqual(h.resultNavigations, []);
  await h.advance(1000);
  assert.deepEqual(h.resultNavigations, ["/jobs/recommend"]);
  assert.ok(h.resultNavigationTimes[0] - closedAt >= 5000);
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B]);
  assert.deepEqual(h.detailCloses, [fixture.A, fixture.B]);
  assert.deepEqual(h.resultNavigations, ["/jobs/recommend", "/jobs/recommend"]);
  assert.equal(h.state, null);
});

test("Jobright reopens only its pre-close observed results link when its own close unmounts the filters", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeBehavior: "filters-missing", resultsNavigation: true });
  const committed = h.window.JobrightJobScraper.searchContext().filterKey;
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  const closedAt = h.closeAttempts[0].at;
  assert.equal(h.window.location.pathname, "/jobs/recommend");
  assert.equal(h.document.querySelector("[class*='index_jobs-list-leave__']"), null);
  assert.equal(h.document.querySelector("header"), null);
  assert.equal(h.window.JobrightJobScraper.searchContext().filterKey, "");
  await h.advance(Math.max(0, closedAt + 4900 - h.now));
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(h.selections, [fixture.A], "missing controls never authorize selecting the next job");
  await h.advance(1000);
  assert.deepEqual(h.resultNavigations, ["/jobs/recommend"]);
  assert.ok(h.resultNavigationTimes[0] - closedAt >= 5000);
  assert.equal(h.window.JobrightJobScraper.searchContext().filterKey, committed);
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B]);
  assert.ok(h.captures.every(capture => capture.job.searchContextKey === committed && capture.job.selectedRegion === "us"));
  assert.deepEqual(h.resultNavigations, ["/jobs/recommend", "/jobs/recommend"]);
  assert.equal(h.state, null);
});

for (const change of ["replaced", "retargeted", "hidden"]) test(`Jobright rejects a ${change} results link after its own close removes the filters`, async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, closeBehavior: "filters-missing", resultsNavigation: true });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  const link = h.document.querySelector("a[href='/jobs/recommend']");
  const unexpected = [];
  if (change === "replaced") {
    const replacement = link.cloneNode(true);
    replacement.addEventListener("click", event => { event.preventDefault(); unexpected.push("replaced link clicked"); });
    link.replaceWith(replacement);
  } else if (change === "retargeted") link.href = "/jobs/recommend?country=Canada";
  else link.hidden = true;
  await h.advance(95_000);
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(h.closeAttempts.map(attempt => attempt.id), ["job-detail-close-button"]);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.captures.length, 1);
  assert.equal(h.state, null);
});

test("Jobright does not use the cached results link after a readable changed country returns", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeBehavior: "filters-missing", resultsNavigation: true });
  const country = h.document.querySelector("[data-preference-key='country']").cloneNode(true);
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  const label = country.querySelector("span"); label.title = "United Kingdom"; label.textContent = "United Kingdom";
  h.document.body.prepend(country);
  await h.advance(6000);
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.captures.length, 1);
  assert.equal(h.state, null);
});

test("Jobright does not use the cached results link after the current search query changes", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeBehavior: "filters-missing", resultsNavigation: true });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  h.window.history.replaceState({}, "", "/jobs/recommend?country=Canada");
  await h.advance(6000);
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.state, null);
});

test("stopping Jobright after its own close unmounts filters prevents cached-link recovery", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeBehavior: "filters-missing", resultsNavigation: true });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  await h.request({ type: "KAI_TRACKER_RUN_STOP" });
  await h.advance(95_000);
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.captures.length, 1);
  assert.equal(h.state, null);
});

test("missing initial Jobright search controls cannot authorize an observed results-link recovery", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, resultsNavigation: true });
  h.document.querySelector("header").remove();
  await h.advance(95_000);
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(h.closeAttempts, []);
  assert.deepEqual(h.selections, []);
  assert.equal(h.captures.length, 0);
});

for (const staleControl of ["hidden", "inert", "disabled"]) test(`Jobright never clicks a ${staleControl} stale close ahead of the enabled close`, async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, detailsOnOpen(details) {
    const stale = details.querySelector("#job-detail-close-button"), enabled = stale.cloneNode(true);
    stale.id = "stale-job-detail-close-button";
    if (staleControl === "hidden") stale.hidden = true;
    else if (staleControl === "inert") { const parent = details.ownerDocument.createElement("div"); parent.setAttribute("inert", ""); stale.replaceWith(parent); parent.append(stale); }
    else stale.disabled = true;
    if (staleControl === "inert") stale.parentElement.after(enabled);
    else stale.after(enabled);
  } });
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B]);
  assert.deepEqual(h.closeAttempts.map(attempt => attempt.id), ["job-detail-close-button", "job-detail-close-button"]);
  assert.deepEqual(h.resultNavigations, []);
  assert.equal(h.state, null);
});

test("ambiguous enabled Jobright close controls use the observed exact results link without guessing a close", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, resultsNavigation: true, detailsOnOpen(details) {
    const close = details.querySelector("#job-detail-close-button"), second = close.cloneNode(true);
    second.id = "second-job-detail-close-button"; close.after(second);
  } });
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
  assert.deepEqual(h.closeAttempts, []);
  assert.deepEqual(h.resultNavigations, [`/jobs/info/${fixture.A}`]);
  assert.equal(h.state, null);
});

test("an enabled no-op Jobright close falls back once to the observed exact search after five seconds", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, closeBehavior: "noop", resultsNavigation: true });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  assert.equal(h.closeAttempts.length, 1);
  const closedAt = h.closeAttempts[0].at;
  await h.advance(Math.max(0, closedAt + 4900 - h.now));
  assert.deepEqual(h.resultNavigations, [], "do not navigate while the selected close may still be completing");
  await h.advance(1000);
  assert.deepEqual(h.resultNavigations, [`/jobs/info/${fixture.A}`]);
  assert.ok(h.resultNavigationTimes[0] - closedAt >= 5000 && h.resultNavigationTimes[0] - closedAt <= 5400);
  await h.advance(180_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A]);
  assert.equal(h.closeAttempts.length, 1); assert.equal(h.resultNavigations.length, 1);
  assert.equal(h.state, null);
});

for (const href of ["https://unrelated.example/jobs/recommend", "/jobs/recommend?country=Canada"]) test(`a no-op Jobright close never follows the unsafe results link ${href}`, async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, closeBehavior: "noop", resultsNavigation: href });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  await h.advance(95_000);
  assert.deepEqual(h.closeAttempts.map(attempt => attempt.id), ["job-detail-close-button"]);
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.state, null);
});

test("a committed country change while a no-op Jobright close waits blocks the fallback link", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeBehavior: "noop", resultsNavigation: true });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  const country = h.document.querySelector("[data-preference-key='country'] span");
  country.setAttribute("title", "United Kingdom"); country.textContent = "United Kingdom";
  await h.advance(6000);
  assert.deepEqual(h.closeAttempts.map(attempt => attempt.id), ["job-detail-close-button"]);
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.state, null);
});

test("missing committed Jobright filters never authorize the no-op close fallback", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeBehavior: "noop", resultsNavigation: true });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  h.document.querySelector("header").remove();
  await h.advance(95_000);
  assert.equal(h.closeAttempts.length, 1);
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.captures.length, 1, "the missing filters cannot authorize another job capture");
  assert.equal(h.state, null);
});

test("stopping during Jobright's return wait prevents its delayed fallback and next selection", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeBehavior: "noop", resultsNavigation: true });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  await h.request({ type: "KAI_TRACKER_RUN_STOP" });
  await h.advance(0);
  assert.match(h.document.querySelector("[data-job-tracker-collection]").textContent, /stopped/iu);
  assert.deepEqual(h.resultNavigations, []);
  await h.advance(250);
  assert.equal(h.state, null);
  await h.advance(95_000);
  assert.deepEqual(h.closeAttempts.map(attempt => attempt.id), ["job-detail-close-button"]);
  assert.deepEqual(h.resultNavigations, []);
  assert.deepEqual(h.selections, [fixture.A]);
  assert.equal(h.captures.length, 1);
});

test("Jobright's return deadline uses wall time even if a background timer resumes late", async (t) => {
  const h = setup(t, { jobs: [fixture.job()], listLeaveOnSelect: true, closeBehavior: "noop" });
  for (let elapsed = 0; elapsed < 60_000 && !h.closeAttempts.length; elapsed += 1000) await h.advance(1000);
  assert.ok(h.state);
  h.jump(91_000);
  await h.advance(0);
  assert.equal(h.state, null, "a resumed callback must not start another ninety seconds of polling");
  assert.equal(h.closeAttempts.length, 1);
  assert.deepEqual(h.resultNavigations, []);
});

test("Jobright stops after a bounded wait when the closed detail never restores the result list", async (t) => {
  const h = setup(t, { listLeaveOnSelect: true, closeFadeDelay: Infinity });
  for (let elapsed = 0; elapsed < 60_000 && !h.detailCloses.length; elapsed += 1000) await h.advance(1000);
  assert.deepEqual(h.detailCloses, [fixture.A]);
  await h.advance(1000);
  assert.ok(h.state, "the closing transition must have time to restore the verified search");
  await h.advance(95_000);
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
test("an unreadable Jobright description reports bounded selected-layout diagnostics and continues without capturing skills as duties", async (t) => {
  const h = setup(t, { hidden: true, detailsOnOpen(details, job) {
    if (job.id === fixture.A) details.querySelector('#overview-1').innerHTML = '<h2>Skills</h2><p>Java, React, SQL.</p><div class="ant-skeleton" aria-busy="true"></div>';
  } });
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.B]);
  const report = h.messages.find(value => value.type === 'KAI_TRACKER_NOT_SAVED' && value.job.jobId === fixture.A);
  assert.equal(report.reasonCode, 'DETAILS_NOT_CONFIRMED');
  assert.equal(report.job.detailAvailability, 'unavailable');
  assert.equal(report.job.description, undefined);
  const diagnostic = JSON.parse(report.job.descriptionDiagnostics);
  assert.equal(diagnostic.sourceJobId, fixture.A);
  assert.equal(diagnostic.selectedPanelCount, 1);
  assert.equal(diagnostic.descriptionLength, 0);
  assert.equal(diagnostic.counts.busy, 1);
  assert.equal(diagnostic.counts.skeletons, 1);
  assert.equal(diagnostic.viewport.documentHidden, true);
  assert.ok(diagnostic.headings.some(heading => heading.label === 'Skills'));
  assert.ok(report.job.descriptionDiagnostics.length <= 3900);
  assert.doesNotMatch(report.job.descriptionDiagnostics, /Java, React|Jane Doe|private@example/u);
});
for (const removeCardOnOpen of [false, true]) test(`the authorized Jobright qualification section hydrates after being revealed and receives a full review (card removed: ${removeCardOnOpen})`, async (t) => {
  let revealed = 0, hydratedAt = null;
  const captureTimes = [];
  const h = setup(t, { hidden: true, removeCardOnOpen, detailsOnOpen(details, job) {
    if (job.id !== fixture.A) return;
    const overview = details.querySelector('#overview-1'), ready = overview.innerHTML;
    overview.innerHTML = '<section id="skills-section" class="index_sectionContent__prVJT index_skills__8_eCj"><div class="index_main___BY9M"><h2>Qualification</h2></div></section>';
    const section = overview.querySelector('#skills-section');
    section.scrollIntoView = () => {
      if (revealed++) return;
      h.window.setTimeout(() => { overview.innerHTML = ready; hydratedAt = h.window.Date.now(); }, 10000);
    };
  } });
  const sendMessage = h.window.chrome.runtime.sendMessage;
  h.window.chrome.runtime.sendMessage = async value => {
    if (value.type === 'KAI_TRACKER_CAPTURE') captureTimes.push({ id: value.job.jobId, at: h.window.Date.now() });
    return sendMessage(value);
  };
  await h.advance(6000);
  assert.ok(revealed > 0, 'the actual selected empty Qualification section is revealed');
  assert.equal(h.captures.length, 0, 'a heading alone cannot authorize capture');
  await h.advance(180000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [fixture.A, fixture.B]);
  assert.ok(captureTimes.find(capture => capture.id === fixture.A).at >= hydratedAt + 5000, 'hydrated engineering duties receive a complete review');
  assert.equal(h.messages.some(value => value.type === 'KAI_TRACKER_NOT_SAVED'), false);
  assert.deepEqual(h.actions, []);
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
