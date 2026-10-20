const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const collectionLocks = require("./fixtures/collection-locks.js");
const root = path.resolve(__dirname, "..");
const SEARCH = "https://www.linkedin.com/jobs/search-results/?keywords=developer";
const item = (id, extra = {}) => ({ id: String(id), company: `Company ${id}`, title: `Engineer ${id}`, description: `Job ${id}. ` + "Build useful software for our customers. ".repeat(15), ...extra });
function fixture(t, pages, { modern = false, nextLoads = true, lazy = null, covered = false, restoredVisited = [], renderDelay = 0, holdCapture = false,
  standaloneTitle = false, dismissRemovesCard = false, reportError = false, holdReport = false, detailTransition = null, detailRenderDelay = 450,
  dismissCancelsDetails = false, lazyDescriptionDelay = null, locks = collectionLocks(), runId = "authorized-run" } = {}) {
  const dom = new JSDOM("<html><body><div class='jobs-search-results-list' style='overflow-y:auto'><ul></ul><nav class='jobs-search-pagination'></nav></div><div class='jobs-details'></div></body></html>", { url: SEARCH, runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window, document = window.document;
  let time = 0, timerId = 0, page = 0, scrollTop = 0, hidden = false;
  const timers = new Map(), captures = [], selections = [], dismissals = [], nextClicks = [], messages = [], listeners = [], notices = [];
  const detailRenders = [];
  const detailReveals = [];
  let pendingDescription = null;
  const dismissedIds = new Set();
  const append = document.documentElement.append.bind(document.documentElement);
  document.documentElement.append = (...nodes) => {
    for (const node of nodes) if (node.dataset?.collectionNotice) notices.push({ text: node.textContent, tone: node.dataset.collectionNotice, time });
    append(...nodes);
  };
  const tracked = new Set();
  let releaseCapture;
  let releaseReport;
  let state = { id: runId, searchKey: window.location.href, visited: [...restoredVisited], pages: [], counts: { saved: 0, researching: 0, skipped: 0 } };
  window.Date.now = () => time; window.Math.random = () => 0.5;
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, at: time + Number(delay || 0) }); return timerId; };
  window.clearTimeout = (id) => timers.delete(id); window.setInterval = () => 0;
  window.MutationObserver = class { observe() {} };
  Object.defineProperty(document, "hidden", { get: () => hidden });
  const leases = locks;
  Object.defineProperty(window.navigator, "locks", { value: locks });
  const scroller = document.querySelector(".jobs-search-results-list");
  Object.defineProperties(scroller, { scrollTop: { get: () => scrollTop, set: (value) => { scrollTop = value; } }, clientHeight: { get: () => 300 }, scrollHeight: { get: () => 700 } });
  scroller.scrollTo = ({ top }) => {
    scrollTop = top;
    if (lazy && page === 0 && top >= 400 && !pages[0].some((job) => job.id === lazy.id)) {
      window.setTimeout(() => { pages[0].push(lazy); render(); }, 700);
    }
  };
  window.HTMLElement.prototype.scrollIntoView = function () {
    if (this.closest(".jobs-details")) {
      detailReveals.push({ time });
      if (pendingDescription && !pendingDescription.started) {
        const pending = pendingDescription; pending.started = true;
        window.setTimeout(() => { if (pending.body.isConnected) pending.body.textContent = pending.job.description; }, lazyDescriptionDelay);
      }
      return;
    }
    scrollTop = this.matches("[data-job-id], [componentkey]") ? 0 : 400;
  };
  const rect = (left, top, width, height) => ({ left, right: left + width, top, bottom: top + height, width, height, x: left, y: top });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches("[data-job-id], [componentkey]")) return rect(20, 100 + Number(this.dataset.index) * 80 - scrollTop, 320, 75);
    if (this.matches("button[aria-label^='Dismiss '], button[aria-label^='Undo']")) {
      const bounds = this.parentElement.getBoundingClientRect(); return rect(bounds.right - 26, bounds.top + 6, 20, 20);
    }
    if (this.getAttribute("aria-label") === "View next page") return rect(260, 650 - scrollTop, 80, 35);
    if (this.matches(".job-card-list__title--link")) { const bounds = this.parentElement.getBoundingClientRect(); return rect(bounds.left, bounds.top, 300, 25); }
    if (this === scroller) return rect(0, 100, 360, 300);
    if (this.closest("[data-job-tracker-collection]")) return rect(680, 18, 300, 100);
    return rect(0, 0, 0, 0);
  };
  document.elementFromPoint = (x, y) => covered ? document.body : [...document.querySelectorAll("button[aria-label^='Dismiss '], button[aria-label^='Undo']"), ...document.querySelectorAll("[data-job-id], [componentkey], button[aria-label='View next page']")].find((node) => {
    const bounds = node.getBoundingClientRect(); return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  }) || document.body;
  function details(job) {
    const target = document.querySelector(".jobs-details");
    const heading = standaloneTitle ? "p" : "h1";
    target.innerHTML = `<div class='job-details-jobs-unified-top-card'><${heading}><a href='/jobs/view/${job.id}/'>${job.title}</a></${heading}><a href='/company/${job.id}/'>${job.company}</a><button>${job.workplace || "Remote"}</button><button>${job.easy ? "Easy Apply" : "Apply"}</button></div><section componentkey='JobDetails_AboutTheJob'><h2>About the job</h2><div class='jobs-description__content'><div class='jobs-box__html-content'></div></div></section>`;
    target.querySelector(".jobs-box__html-content").setAttribute("data-testid", "expandable-text-box");
    const body = target.querySelector(".jobs-box__html-content");
    body.textContent = lazyDescriptionDelay === null ? job.description : "";
    pendingDescription = lazyDescriptionDelay === null ? null : { body, job, started: false };
    detailRenders.push({ id: job.id, time });
  }
  function render() {
    const list = document.querySelector("ul"); list.replaceChildren();
    pages[page].forEach((job, index) => {
      const card = document.createElement(modern ? "div" : "li"); card.dataset.index = index;
      if (modern) {
        card.setAttribute("role", "button"); card.setAttribute("componentkey", `job-card-component-ref-${job.id}`);
        card.innerHTML = `<p><span aria-hidden='true'>${job.title}</span></p><p>${job.company}</p><p>United Kingdom (Remote)</p>`;
      } else {
        card.setAttribute("data-occludable-job-id", job.id); card.dataset.jobId = job.id;
        card.innerHTML = `<a class='job-card-list__title--link' href='/jobs/view/${job.id}/'>${job.title}</a><p data-test-job-card-company-name>${job.company}</p>`;
      }
      const button = document.createElement("button"); button.textContent = job.dismissed ? "Undo" : "×";
      button.setAttribute("aria-label", job.dismissed ? `Undo dismissal of ${job.title} job` : `Dismiss ${job.title} job`);
      if (job.dismissed) { const hint = document.createElement("span"); hint.textContent = "We won’t recommend this job anymore."; card.append(hint); }
      button.addEventListener("click", (event) => {
        event.stopPropagation(); dismissals.push(job.id);
        assert.equal(button.textContent, "×", "collection must never click Undo");
        job.dismissed = true;
        dismissedIds.add(job.id);
        button.textContent = "Undo"; button.setAttribute("aria-label", `Undo dismissal of ${job.title} job`);
        card.setAttribute("aria-disabled", "true"); card.style.opacity = "0.5";
        const hint = document.createElement("span"); hint.textContent = "We won’t recommend this job anymore."; card.append(hint);
        if (dismissRemovesCard) card.remove();
      }); card.append(button);
      card.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        event.preventDefault(); selections.push({ id: job.id, time, target: event.target.tagName });
        window.history.replaceState({}, "", `${SEARCH}&start=${page * 25}&currentJobId=${job.id}`);
        window.setTimeout(() => {
          if (dismissCancelsDetails && dismissedIds.has(job.id)) return;
          if (detailTransition) detailTransition(job, { document, window, renderDetails: details });
          else details(job);
        }, detailRenderDelay);
      }); list.append(card);
    });
    const pagination = document.querySelector("nav"); pagination.innerHTML = `<button aria-current='page'>${page + 1}</button><button aria-label='View next page'>Next</button>`;
    const next = pagination.querySelector("button[aria-label]"); next.disabled = page === pages.length - 1;
    next.addEventListener("click", () => {
      nextClicks.push(page);
      if (nextLoads) window.setTimeout(() => { page++; scrollTop = 0; window.history.replaceState({}, "", `${SEARCH}&start=${page * 25}`); render(); }, 800);
    });
  }
  if (renderDelay) window.setTimeout(render, renderDelay); else render();
  details(item(999));
  window.chrome = { runtime: {
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      messages.push(structuredClone(message));
      if (message.type === "KAI_TRACKER_NOT_SAVED") {
        if (reportError) throw new Error("The report folder is unavailable.");
        if (holdReport) { holdReport = false; await new Promise(resolve => { releaseReport = resolve; }); }
        return { ok: true, result: { reported: true } };
      }
      if (message.type === "KAI_TRACKER_RUN_STATE") return { ok: true, result: { state: structuredClone(state) } };
      if (message.type === "KAI_TRACKER_RUN_WAIT") return new Promise((resolve) => {
        timers.set(++timerId, { at: time + message.milliseconds,
          callback: () => resolve({ ok: true, result: { stopped: state?.id !== message.runId } }) });
      });
      if (message.type === "KAI_TRACKER_RUN_CHECKPOINT") { const stopped = state?.id !== message.runId; if (!stopped) state = structuredClone(message.state); return { ok: true, result: { stopped } }; }
      if (message.type === "KAI_TRACKER_RUN_END") { if (state?.id === message.runId) state = null; return { ok: true, result: { stopped: true } }; }
      if (message.type === "KAI_TRACKER_CAPTURE") {
        captures.push({ job: structuredClone(message.job), time, runId: message.runId });
        if (holdCapture) { holdCapture = false; await new Promise((resolve) => { releaseCapture = resolve; }); }
        if (!message.job.isEasyApply && message.job.workplaceType === "remote") tracked.add(message.job.company);
        return { ok: true, result: { status: message.job.isEasyApply || message.job.workplaceType !== "remote" ? "researching" : "inserted" } };
      }
      if (message.type === "KAI_TRACKER_CLASSIFY_COMPANIES") return { ok: true, result: { companies: message.companies.map((company) => ({ company, banned: company === "Blocked", duplicate: tracked.has(company) ? { company } : null })) } };
      throw new Error(`Unexpected message: ${message.type}`);
    }
  } };
  for (const file of ["scraper.js", "job-collector.js", "content.js"]) window.eval(fs.readFileSync(path.join(root, "src", file), "utf8"));
  return { document, window, captures, selections, dismissals, nextClicks, messages, listeners, timers, notices, leases, detailRenders, detailReveals,
    releaseCapture() { releaseCapture(); },
    releaseReport() { releaseReport(); },
    restart(id = "new-run") {
      state = { id, searchKey: SEARCH, visited: [], pages: [], counts: { saved: 0, researching: 0, skipped: 0 } };
      return new Promise((resolve) => listeners[0]({ type: "KAI_TRACKER_RUN_START", state }, {}, resolve));
    },
    hide(value) { hidden = value; },
    async advance(amount) {
      const until = time + amount; await new Promise((resolve) => setImmediate(resolve));
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].callback(); await new Promise((resolve) => setImmediate(resolve));
      }
      time = until;
    }
  };
}
function changeDetailHeader(document, job) {
  const header = document.querySelector(".job-details-jobs-unified-top-card");
  const title = header.querySelector("a[href*='/jobs/view/']");
  title.href = `/jobs/view/${job.id}/`; title.textContent = job.title;
  const company = header.querySelector("a[href*='/company/']");
  company.href = `/company/${job.id}/`; company.textContent = job.company;
}

const identicalBigId = { company: "BigID", title: "Senior Software Engineer", easy: true,
  description: "Design and build production data services, maintain automated tests, and improve service reliability. ".repeat(2) };

test("an unchanged previous description is never captured under a different job ID even after a new DOM render", async (t) => {
  const h = fixture(t, [[item(101, identicalBigId), item(102, { ...identicalBigId, company: "BIGID", title: "SENIOR SOFTWARE ENGINEER" }), item(103)]],
    { modern: true, standaloneTitle: true, dismissRemovesCard: true });
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["101", "103"]);
  assert.equal(h.captures[0].job.jobIdSource, "details");
  assert.deepEqual(h.dismissals, ["101", "102", "103"]);
  const report = h.messages.find(message => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(report?.job.jobId, "102");
  assert.equal(report?.reasonCode, "DETAILS_NOT_CONFIRMED");
});

test("a new LinkedIn header cannot authorize an identical description retained in the previous body node", async (t) => {
  const h = fixture(t, [[item(101, identicalBigId), item(102, identicalBigId)]], { detailTransition(job, context) {
    if (job.id === "102") changeDetailHeader(context.document, job);
    else context.renderDetails(job);
  } });
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["101"]);
  const current = h.window.LinkedInJobScraper.scrape(h.document, h.window.location.href);
  assert.equal(current.jobId, "102"); assert.equal(current.jobIdSource, "details");
  assert.equal(current.description, h.captures[0].job.description);
  const report = h.messages.find(message => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(report?.job.jobId, "102"); assert.equal(report?.reasonCode, "DETAILS_NOT_CONFIRMED");
});

for (const changed of [{ id: "999" }, { company: "Different Employer" }, { title: "Different Vacancy" }]) test(`a fresh description render cannot override the wrong selected ${Object.keys(changed)[0]}`, async (t) => {
  const h = fixture(t, [[item(101, identicalBigId), item(102, identicalBigId)]], { detailTransition(job, context) {
    context.renderDetails(job.id === "102" ? { ...job, ...changed } : job);
  } });
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["101"]);
  const current = h.window.LinkedInJobScraper.scrape(h.document, h.window.location.href);
  const report = h.messages.find(message => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(report?.job.jobId, "102"); assert.equal(report?.reasonCode, "DETAILS_NOT_CONFIRMED");
});

test("a slow LinkedIn body replacement must change, settle and receive a full review before capture", async (t) => {
  const next = item(102, { ...identicalBigId, description: "Build different production software for the selected job. ".repeat(3) });
  const h = fixture(t, [[item(101, identicalBigId), next]], { detailTransition(job, context) {
    if (job.id !== "102") { context.renderDetails(job); return; }
    changeDetailHeader(context.document, job);
    context.window.setTimeout(() => context.renderDetails(job), 60000);
  } });
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["101", "102"]);
  const committed = h.detailRenders.find(render => render.id === "102");
  assert.ok(h.captures[1].time >= committed.time + 5000, "the newly rendered body receives its own review delay");
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
});

test("slow selected descriptions finish loading before native dismissal can cancel their request", async (t) => {
  const h = fixture(t, [[item(1), item(2, { easy: true })]], { modern: true, standaloneTitle: true,
    detailRenderDelay: 60000, dismissCancelsDetails: true, dismissRemovesCard: true });
  await h.advance(50000);
  assert.deepEqual(h.dismissals, [], "the selected card stays intact throughout the network wait");
  assert.equal(h.captures.length, 0);
  await h.advance(250000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["1", "2"]);
  assert.deepEqual(h.dismissals, ["1", "2"]);
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
});

test("a delayed capture acknowledgment cannot dismiss a card after Escape stops collection", async (t) => {
  const h = fixture(t, [[item(1)]], { holdCapture: true });
  await h.advance(35000);
  assert.equal(h.captures.length, 1);
  assert.deepEqual(h.dismissals, []);
  h.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape" }));
  h.releaseCapture(); await h.advance(10000);
  assert.deepEqual(h.dismissals, []);
  assert.equal(h.captures.length, 1, "the accepted capture is never retried after cancellation");
  assert.match(h.notices.at(-1).text, /stopped/);
});

test("a delayed failure report cannot dismiss a card after Escape stops collection", async (t) => {
  const h = fixture(t, [[item(1, { description: "" })]], { holdReport: true });
  await h.advance(100000);
  assert.equal(h.messages.filter(message => message.type === "KAI_TRACKER_NOT_SAVED").length, 1);
  assert.deepEqual(h.dismissals, []);
  h.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape" }));
  h.releaseReport(); await h.advance(10000);
  assert.deepEqual(h.dismissals, []);
  assert.equal(h.captures.length, 0);
  assert.match(h.notices.at(-1).text, /stopped/);
});

test("lazy descriptions below the viewport load when their selected About section is revealed", async (t) => {
  const h = fixture(t, [[item(1), item(2, { easy: true })]], { modern: true, standaloneTitle: true, lazyDescriptionDelay: 25000 });
  await h.advance(20000);
  assert.equal(h.captures.length, 0);
  assert.equal(h.dismissals.length, 0);
  assert.ok(h.detailReveals.length > 0, "the selected details pane is revealed without selecting another card");
  await h.advance(200000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["1", "2"]);
  assert.equal(h.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
});

test("legacy and modern result cards collect using actual scraper details, skip grey and banned cards, and stop at disabled Next", async (t) => {
  for (const modern of [false, true]) {
    const h = fixture(t, [[item(1), item(2, { workplace: "Hybrid" }), item(3, { dismissed: true }), item(4, { company: "Blocked" }), item(5, { company: "Company 1" })], [item(1), item(6, { easy: true })]], { modern });
    await h.advance(600_000);
    assert.deepEqual(h.captures.map((entry) => entry.job.jobId), ["1", "2", "6"], JSON.stringify({ selections: h.selections, notices: h.notices, scraped: h.window.LinkedInJobScraper.scrape(h.document, h.window.location.href) }));
    assert.equal(h.captures[1].job.workplaceType, "hybrid"); assert.equal(h.captures[2].job.isEasyApply, true);
    assert.deepEqual(h.selections.map((entry) => entry.id), ["1", "2", "6"]);
    assert.ok(h.selections.every((entry) => entry.target === (modern ? "DIV" : "A")), "selection activates the real control in each layout");
    assert.deepEqual(h.dismissals, ["1", "2", "6"], "each selected card closes with X and still submits once");
    assert.deepEqual(h.nextClicks, [0]);
    assert.match(h.notices.at(-1).text, /last results page/);
    assert.equal(h.notices.length, 2, "only start and completion alerts appear, without per-job progress");
    assert.equal(h.document.querySelector("[data-job-tracker-collection]"), null, "notices disappear and no persistent panel remains");
    for (const capture of h.captures) assert.ok(capture.time - h.selections.find((entry) => entry.id === capture.job.jobId).time >= 5_000);
  }
});

test("the SunBrowser standalone-title layout saves the selected job once after its own X greys or removes the card", async (t) => {
  for (const dismissRemovesCard of [false, true]) {
    const h = fixture(t, [[item(1, { easy: true }), item(2)], [item(3)]], { modern: true, standaloneTitle: true, dismissRemovesCard });
    await h.advance(300_000);
    assert.deepEqual(h.captures.map((entry) => entry.job.jobId), ["1", "2", "3"]);
    assert.ok(h.captures.every((entry) => entry.job.jobIdSource === "details"));
    assert.deepEqual(h.dismissals, ["1", "2", "3"]);
    assert.deepEqual(h.nextClicks, [0], "removing all current cards still reaches Next");
    assert.equal(h.messages.filter((message) => message.type === "KAI_TRACKER_CAPTURE").length, 3, "normal click behavior does not also fire a second capture");
    assert.ok(h.captures.every((entry) => entry.runId === "authorized-run"));
    assert.match(h.notices.at(-1).text, /last results page/);
  }
});
test("lazy-loaded cards are collected before choosing Next, and a stopped run does not replay restored attempts", async (t) => {
  const h = fixture(t, [[item(1)], [item(3)]], { lazy: item(2), restoredVisited: ["1"] });
  await h.advance(600_000); assert.deepEqual(h.captures.map((entry) => entry.job.jobId), ["2", "3"]);
  const k = fixture(t, [[item(4), item(5)]]);
  await k.advance(0);
  assert.equal(k.document.querySelector("[data-collection-notice]")?.textContent, "Job collection started.");
  assert.equal(k.document.querySelector("[data-collection-counts], [data-job-tracker-collection] button"), null);
  await k.advance(5000); assert.equal(k.document.querySelector("[data-collection-notice]"), null);
  await k.advance(7000);
  k.document.dispatchEvent(new k.window.KeyboardEvent("keydown", { key: "Escape" })); await k.advance(600_000);
  assert.equal(k.captures.length, 0); assert.deepEqual(k.selections.map((entry) => entry.id), ["4"]);
  assert.match(k.notices.at(-1).text, /stopped/);
  assert.equal(k.notices.filter((notice) => /stopped/.test(notice.text)).length, 1, "a stop alert is not repeated when the run settles");
  assert.equal(k.document.querySelector("[data-collection-notice]"), null);
});
test("a failed Next transition or a covered card stops without selecting or saving unrelated jobs", async (t) => {
  const h = fixture(t, [[item(1)], [item(2)]], { nextLoads: false });
  await h.advance(600_000); assert.deepEqual(h.captures.map((entry) => entry.job.jobId), ["1"]); assert.deepEqual(h.nextClicks, [0]);
  assert.match(h.notices.at(-1).text, /next page did not load/); assert.equal(h.notices.at(-1).tone, "warning");
  assert.equal(h.document.querySelector("[data-collection-notice]"), null);
  const k = fixture(t, [[item(3)]], { covered: true }); await k.advance(600_000);
  assert.equal(k.captures.length, 0); assert.equal(k.selections.length, 0);
  assert.match(k.notices.at(-1).text, /covered/); assert.equal(k.notices.at(-1).tone, "warning");
  assert.equal(k.document.querySelector("[data-collection-notice]"), null);
});
test("a resumed run waits for delayed result hydration and Escape cancels that wait", async (t) => {
  const h = fixture(t, [[item(1)]], { renderDelay: 2500 }); await h.advance(2000);
  assert.equal(h.document.querySelector("[data-job-tracker-collection]"), null, "waiting for results does not show a panel");
  assert.equal(h.captures.length, 0); await h.advance(300_000); assert.equal(h.captures.length, 1);
  const k = fixture(t, [[item(2)]], { renderDelay: 2500 }); await k.advance(1000);
  k.document.dispatchEvent(new k.window.KeyboardEvent("keydown", { key: "Escape" })); await k.advance(300_000);
  assert.equal(k.selections.length, 0); assert.equal(k.captures.length, 0);
  assert.match(k.notices.at(-1).text, /stopped/);
  assert.equal(k.document.querySelector("[data-collection-notice]"), null);
});
test("a rapid stop and restart waits for an accepted save to settle without leaving two collectors", async (t) => {
  const h = fixture(t, [[item(1), item(2)]], { holdCapture: true }); await h.advance(35_000);
  assert.equal(h.captures.length, 1);
  h.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape" }));
  const restarted = h.restart(); await h.advance(1000);
  assert.equal(h.selections.length, 1);
  h.releaseCapture(); await h.advance(0); await restarted; await h.advance(300_000);
  assert.deepEqual(h.captures.map((entry) => entry.job.jobId), ["1", "2"]);
  assert.equal(h.captures[1].runId, "new-run");
});

test("hidden LinkedIn results still select, dismiss and capture once across pages, while Escape cancels review", async (t) => {
  for (const dismissRemovesCard of [false, true]) {
    const h = fixture(t, [[item(1)], [item(2, { easy: true })]], { modern: true, standaloneTitle: true, dismissRemovesCard });
    h.hide(true);
    assert.equal(h.document.hasFocus(), false, "collection does not require the LinkedIn document to have focus");
    await h.advance(300_000);
    assert.deepEqual(h.captures.map((entry) => entry.job.jobId), ["1", "2"]);
    assert.deepEqual(h.dismissals, ["1", "2"]);
    assert.deepEqual(h.nextClicks, [0]);
    assert.ok(h.messages.some((entry) => entry.type === "KAI_TRACKER_RUN_WAIT"));
    assert.equal(h.leases.acquired, 1);
    assert.equal(h.leases.released, 1);
    assert.equal(h.leases.held, false);
  }
  const stopped = fixture(t, [[item(3), item(4)]]);
  stopped.hide(true); await stopped.advance(12_000);
  stopped.document.dispatchEvent(new stopped.window.KeyboardEvent("keydown", { key: "Escape" }));
  await stopped.advance(300_000);
  assert.equal(stopped.captures.length, 0);
  assert.deepEqual(stopped.selections.map((entry) => entry.id), ["3"]);
  assert.equal(stopped.leases.held, false);
});

test("independent LinkedIn runs share an origin without blocking each other's background collection", async (t) => {
  const locks = collectionLocks();
  const first = fixture(t, [[item(1)]], { locks, runId: "first-run" });
  const second = fixture(t, [[item(2)]], { locks, runId: "second-run" });
  first.hide(true); second.hide(true);
  await first.advance(1000); await second.advance(1000);
  assert.deepEqual(locks.heldNames.sort(), ["job-tracker-collection:first-run", "job-tracker-collection:second-run"]);
  assert.ok(locks.requests.every((request) => request.ifAvailable === true));
  await first.advance(300_000); await second.advance(300_000);
  assert.deepEqual(first.captures.map((capture) => capture.job.jobId), ["1"]);
  assert.deepEqual(second.captures.map((capture) => capture.job.jobId), ["2"]);
  assert.equal(locks.acquired, 2); assert.equal(locks.released, 2); assert.equal(locks.held, false);
});

test("a replacement LinkedIn document cannot collect or end an owned run and can resume after its lock releases", async (t) => {
  const locks = collectionLocks();
  const first = fixture(t, [[item(1)]], { locks, runId: "same-run" });
  await first.advance(1000);
  const replacement = fixture(t, [[item(2)]], { locks, runId: "same-run" });
  await replacement.advance(1000);
  assert.equal(replacement.captures.length, 0); assert.equal(replacement.selections.length, 0);
  assert.equal(replacement.messages.some((message) => message.type === "KAI_TRACKER_RUN_END"), false);
  assert.deepEqual(locks.heldNames, ["job-tracker-collection:same-run"]);
  await first.advance(300_000); assert.equal(locks.held, false);
  const resumed = replacement.restart("same-run"); await replacement.advance(0); await resumed;
  await replacement.advance(300_000);
  assert.deepEqual(replacement.captures.map((capture) => capture.job.jobId), ["2"]);
  assert.equal(locks.acquired, 2); assert.equal(locks.released, 2); assert.equal(locks.held, false);
});

test("collection reports attempted banned and duplicate cards with card identity and no unrelated description", async (t) => {
  const h = fixture(t, [[item(1), item(2, { company: "Company 1" }), item(3, { company: "Blocked" })]]);
  await h.advance(300_000);
  const reports = h.messages.filter((message) => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.deepEqual(reports.map(({ job, reasonCode }) => [job.jobId, reasonCode]), [["2", "DUPLICATE_COMPANY"], ["3", "BANNED_COMPANY"]]);
  assert.ok(reports.every((report) => report.runId === "authorized-run" && report.job.detailAvailability === "unavailable" && !report.job.description));
  assert.equal(reports[0].job.sourceUrl, "https://www.linkedin.com/jobs/view/2/");
  assert.equal(reports[0].job.company, "Company 1"); assert.equal(reports[0].job.title, "Engineer 2");
  assert.deepEqual(h.captures.map(({ job }) => job.jobId), ["1"]);
  assert.match(h.notices.at(-1).text, /last results page/);
});
test("classification alone and restored visited cards do not produce failure reports", async (t) => {
  const h = fixture(t, [[item(1, { company: "Blocked" })]], { restoredVisited: ["1"] });
  await h.advance(300_000);
  assert.ok(h.messages.some((message) => message.type === "KAI_TRACKER_CLASSIFY_COMPANIES"));
  assert.equal(h.messages.filter((message) => message.type === "KAI_TRACKER_NOT_SAVED").length, 0);
});
test("changed descriptions during review settle and receive a new full review before capture", async (t) => {
  const current = item(1), original = current.description;
  const h = fixture(t, [[current]]);
  await h.advance(12_000);
  assert.equal(h.captures.length, 0);
  h.document.querySelector(".jobs-box__html-content").textContent = "Different description arrived while reviewing the selected job.";
  await h.advance(300_000);
  const reports = h.messages.filter((message) => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(reports.length, 0); assert.equal(h.captures.length, 1);
  assert.notEqual(h.captures[0].job.description, original.trim());
  assert.equal(h.captures[0].job.description, "Different description arrived while reviewing the selected job.");
  assert.ok(h.captures[0].time >= 12000 + 5000, "the new description receives a complete review");
});
test("a covered attempted card is reported and logging failure leaves collection behavior intact", async (t) => {
  const covered = fixture(t, [[item(1)]], { covered: true }); await covered.advance(300_000);
  const report = covered.messages.find((message) => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(report.reasonCode, "CARD_UNAVAILABLE"); assert.equal(report.job.jobId, "1");
  assert.equal(report.job.detailAvailability, "unavailable"); assert.equal(covered.captures.length, 0);
  assert.match(covered.notices.at(-1).text, /covered/);
  const offline = fixture(t, [[item(2, { company: "Blocked" }), item(3)]], { reportError: true }); await offline.advance(300_000);
  assert.deepEqual(offline.captures.map(({ job }) => job.jobId), ["3"]);
  assert.match(offline.notices.at(-1).text, /last results page/);
});
