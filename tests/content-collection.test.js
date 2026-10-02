const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
const SEARCH = "https://www.linkedin.com/jobs/search-results/?keywords=developer";
const item = (id, extra = {}) => ({ id: String(id), company: `Company ${id}`, title: `Engineer ${id}`, description: `Job ${id}. ` + "Build useful software for our customers. ".repeat(15), ...extra });
function fixture(t, pages, { modern = false, nextLoads = true, lazy = null, covered = false, restoredVisited = [], renderDelay = 0, holdCapture = false,
  standaloneTitle = false, dismissRemovesCard = false } = {}) {
  const dom = new JSDOM("<html><body><div class='jobs-search-results-list' style='overflow-y:auto'><ul></ul><nav class='jobs-search-pagination'></nav></div><div class='jobs-details'></div></body></html>", { url: SEARCH, runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window, document = window.document;
  let time = 0, timerId = 0, page = 0, scrollTop = 0, hidden = false;
  const timers = new Map(), captures = [], selections = [], dismissals = [], nextClicks = [], messages = [], listeners = [], notices = [];
  const append = document.documentElement.append.bind(document.documentElement);
  document.documentElement.append = (...nodes) => {
    for (const node of nodes) if (node.dataset?.collectionNotice) notices.push({ text: node.textContent, tone: node.dataset.collectionNotice, time });
    append(...nodes);
  };
  const tracked = new Set();
  let releaseCapture;
  let state = { id: "authorized-run", searchKey: window.location.href, visited: [...restoredVisited], pages: [], counts: { saved: 0, researching: 0, skipped: 0 } };
  window.Date.now = () => time; window.Math.random = () => 0.5;
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, at: time + Number(delay || 0) }); return timerId; };
  window.clearTimeout = (id) => timers.delete(id); window.setInterval = () => 0;
  window.MutationObserver = class { observe() {} };
  Object.defineProperty(document, "hidden", { get: () => hidden });
  const leases = { held: false, acquired: 0, released: 0 };
  Object.defineProperty(window.navigator, "locks", { value: {
    async request(_name, _options, callback) {
      if (leases.held) return callback(null);
      leases.held = true; leases.acquired++;
      try { return await callback({}); }
      finally { leases.held = false; leases.released++; }
    }
  } });
  const scroller = document.querySelector(".jobs-search-results-list");
  Object.defineProperties(scroller, { scrollTop: { get: () => scrollTop, set: (value) => { scrollTop = value; } }, clientHeight: { get: () => 300 }, scrollHeight: { get: () => 700 } });
  scroller.scrollTo = ({ top }) => {
    scrollTop = top;
    if (lazy && page === 0 && top >= 400 && !pages[0].some((job) => job.id === lazy.id)) {
      window.setTimeout(() => { pages[0].push(lazy); render(); }, 700);
    }
  };
  window.HTMLElement.prototype.scrollIntoView = function () { scrollTop = this.matches("[data-job-id], [componentkey]") ? 0 : 400; };
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
    target.innerHTML = `<div class='job-details-jobs-unified-top-card'><${heading}><a href='/jobs/view/${job.id}/'>${job.title}</a></${heading}><a href='/company/${job.id}/'>${job.company}</a><button>${job.workplace || "Remote"}</button><button>${job.easy ? "Easy Apply" : "Apply"}</button></div><div class='jobs-description__content'><div class='jobs-box__html-content'></div></div>`;
    target.querySelector(".jobs-box__html-content").setAttribute("data-testid", "expandable-text-box");
    target.querySelector(".jobs-box__html-content").textContent = job.description;
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
        button.textContent = "Undo"; button.setAttribute("aria-label", `Undo dismissal of ${job.title} job`);
        card.setAttribute("aria-disabled", "true"); card.style.opacity = "0.5";
        const hint = document.createElement("span"); hint.textContent = "We won’t recommend this job anymore."; card.append(hint);
        if (dismissRemovesCard) card.remove();
      }); card.append(button);
      card.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        event.preventDefault(); selections.push({ id: job.id, time, target: event.target.tagName });
        window.history.replaceState({}, "", `${SEARCH}&start=${page * 25}&currentJobId=${job.id}`);
        window.setTimeout(() => details(job), 450);
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
  return { document, window, captures, selections, dismissals, nextClicks, messages, listeners, timers, notices, leases,
    releaseCapture() { releaseCapture(); },
    restart() {
      state = { id: "new-run", searchKey: SEARCH, visited: [], pages: [], counts: { saved: 0, researching: 0, skipped: 0 } };
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
    for (const capture of h.captures) assert.ok(capture.time - h.selections.find((entry) => entry.id === capture.job.jobId).time >= 10_000);
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
