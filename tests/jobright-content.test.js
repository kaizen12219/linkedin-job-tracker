const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const fixture = require("./fixtures/jobright-page.js");
function setup(t, { jobs = [fixture.job(), fixture.job(fixture.B)], autoStart = true, lazy = null, stale = false, hidden = false, blocked = new Set(), changedFilterAt = 0, revealError = "" } = {}) {
  const dom = new JSDOM(fixture.page(jobs, null), { url: "https://jobright.ai/jobs/recommend", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close()); const window = dom.window, document = window.document;
  let time = 0, timerId = 0, scrollTop = 0, state = null, clickHandler;
  const timers = new Map(), captures = [], selections = [], messages = [], actions = [];
  window.Date.now = () => time; window.Math.random = () => .5;
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, at: time + Number(delay || 0) }); return timerId; };
  window.clearTimeout = (id) => timers.delete(id); window.setInterval = () => 0; window.MutationObserver = class { observe() {} };
  Object.defineProperty(document, "hidden", { get: () => hidden });
  const listeners = [];
  const addEventListener = document.addEventListener.bind(document);
  document.addEventListener = (name, listener, options) => { if (name === "click") clickHandler = listener; addEventListener(name, listener, options); };
  Object.defineProperty(window.navigator, "locks", { value: { async request(_name, _options, callback) { return callback({}); } } });
  const scroller = document.querySelector("main");
  Object.defineProperties(scroller, { scrollTop: { get: () => scrollTop }, clientHeight: { get: () => 300 }, scrollHeight: { get: () => 700 } });
  scroller.scrollTo = ({ top }) => {
    scrollTop = top;
    if (lazy && top >= 400) { const next = lazy; lazy = null; window.setTimeout(() => { jobs.push(next); scroller.insertAdjacentHTML("beforeend", fixture.card(next)); wire(); }, 1200); }
  };
  window.HTMLElement.prototype.scrollIntoView = function () { if (revealError) throw new Error(revealError); scrollTop = 0; };
  const wired = new WeakSet();
  function wire() {
    for (const card of document.querySelectorAll(".job-card-flag-classname")) {
      if (wired.has(card)) continue; wired.add(card);
      for (const button of card.querySelectorAll("button")) button.addEventListener("click", () => actions.push(button.dataset.action));
      card.querySelector("a").addEventListener("click", (event) => {
        event.preventDefault(); const value = jobs.find((item) => item.id === card.id); selections.push(value.id);
        window.history.replaceState({}, "", `/jobs/info/${value.id}`);
        if (!stale) window.setTimeout(() => { document.querySelector("#details").innerHTML = fixture.details(value); }, 450);
      });
    }
  }
  wire();
  window.chrome = { runtime: { onMessage: { addListener(listener) { listeners.push(listener); } }, async sendMessage(value) {
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
  function newState() { return { id: "jobright-run", searchKey: window.LinkedInJobCollector.searchKey(window.location.href), filterKey: window.JobrightJobScraper.searchContext().filterKey, visited: [], pages: [], counts: {} }; }
  if (autoStart) state = newState();
  window.eval(fs.readFileSync(require.resolve("../src/jobright-content.js"), "utf8"));
  if (changedFilterAt) window.setTimeout(() => document.querySelector("[data-preference-key='workLocation'] span").setAttribute("title", "Hybrid"), changedFilterAt);
  return { document, window, messages, captures, selections, actions,
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
test("changing committed filters stops before capture", async (t) => {
  const h = setup(t, { changedFilterAt: 3000 }); await h.advance(40_000);
  assert.equal(h.captures.length, 0); assert.equal(h.state, null);
});
test("unconfirmed stale details are reported and never saved", async (t) => {
  const h = setup(t, { stale: true, jobs: [fixture.job()] }); await h.advance(80_000);
  assert.equal(h.captures.length, 0);
  const report = h.messages.find((value) => value.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(report.reasonCode, "DETAILS_NOT_CONFIRMED"); assert.equal(report.job.jobId, fixture.A);
  assert.equal(report.reasonDetail, "Stable details matching the selected job could not be verified before the timeout.");
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
test("manual popup scraping and search context use the same verified adapter", async (t) => {
  const h = setup(t, { autoStart: false, jobs: [fixture.job()] });
  assert.equal((await h.request({ type: "SCRAPE_LINKEDIN_JOB" })).ok, false);
  h.document.querySelector(".job-card-flag-classname a").click(); await h.advance(1000);
  assert.equal((await h.request({ type: "SCRAPE_LINKEDIN_JOB" })).data.jobId, fixture.A);
  const response = await h.request({ type: "KAI_TRACKER_SEARCH_CONTEXT" }); assert.equal(response.result.selectedRegion, "us"); assert.ok(response.result.filterKey);
});
