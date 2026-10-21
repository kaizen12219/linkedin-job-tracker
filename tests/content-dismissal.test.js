const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONTENT = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
const scraperContext = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/scraper.js'), 'utf8'), scraperContext);
const identityTitle = scraperContext.window.LinkedInJobScraper.identityTitle;

function card(company, id) {
  const attributes = new Map([["data-job-id", id]]);
  const result = {
    company, title: "Engineer", isConnected: true, clicks: 0, selections: 0, visible: true,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    contains: () => false,
    closest(selector) { return selector === "button" ? null : this; },
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === "[data-test-job-card-company-name]") return { innerText: this.company };
      if (selector === ".job-card-list__title--link") return { innerText: this.title };
      if (selector.startsWith("button[aria-label^='Dismiss '") && !this.undo && !this.missingButton) return this.button;
      return null;
    }
  };
  result.button = {
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 20, top: 20, width: 20, height: 20 }),
    contains: () => false,
    closest: (selector) => selector === "button" ? result.button : result,
    matches: () => !result.undo,
    click() { result.clicks++; }
  };
  return result;
}

function harness(cards, options = {}) {
  let time = 0;
  let nextTimer = 0;
  let hitButton;
  const timers = new Map();
  const delays = [];
  const messages = [];
  const events = {};
  const listeners = [];
  const states = new Map(cards.map((entry) => [entry.company, "duplicate"]));
  const document = {
    hidden: false,
    addEventListener: (name, callback) => { events[name] = callback; },
    head: { append() {} }, documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => cards,
    createElement: () => ({}),
    elementFromPoint: () => hitButton
  };
  function click(target, overrides = {}) {
    const event = { target, button: 0, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...overrides };
    events.click(event);
    if (!event.stopped && !event.defaultPrevented && cards.includes(target)) {
      target.selections++;
      options.onSelect?.(target);
    }
    return event;
  }
  for (const entry of cards) {
    const nativeClick = entry.button.click;
    entry.button.click = () => { click(entry.button); nativeClick(); };
    const bounds = entry.button.getBoundingClientRect;
    entry.button.getBoundingClientRect = () => {
      hitButton = entry.visible ? entry.button : null;
      return bounds();
    };
  }
  vm.runInNewContext(CONTENT, {
    Date: class extends Date { static now() { return time; } },
    document,
    window: { innerWidth: 1000, innerHeight: 800, location: { href: "https://www.linkedin.com/jobs/search/" },
      ...(options.collector ? { LinkedInJobCollector: options.collector } : {}),
      ...(options.scrape ? { LinkedInJobScraper: { scrape: options.scrape, ...(options.identityTitle ? { identityTitle: options.identityTitle } : {}) } } : {}) },
    MutationObserver: class { observe() {} },
    clearTimeout: (id) => timers.delete(id),
    setTimeout(callback, delay) {
      delays.push(delay);
      timers.set(++nextTimer, { callback, at: time + delay });
      return nextTimer;
    },
    setInterval() {},
    chrome: { runtime: {
      onMessage: { addListener: (callback) => listeners.push(callback) },
      async sendMessage(message) {
        messages.push(message);
        if (message.type === "KAI_TRACKER_RUN_STATE") return { ok: true, result: { state: null } };
        if (message.type === "KAI_TRACKER_CAPTURE") return { ok: true, result: { status: "researching" } };
        if (message.type === "KAI_TRACKER_NOT_SAVED") return { ok: true, result: { reported: true } };
        if (options.respond) {
          const response = await options.respond(message, messages.length);
          if (response) return response;
        }
        return { ok: true, result: { companies: message.companies.map((company) => ({
          company, banned: states.get(company) === "banned",
          duplicate: states.get(company) === "duplicate" ? { company } : null
        })) } };
      }
    } }
  });
  return {
    document, events, states, delays, messages, click,
    refresh() { listeners[0]({ type: "KAI_TRACKER_REFRESH_STYLES" }, {}, () => {}); },
    async advance(amount) {
      await new Promise((resolve) => setImmediate(resolve));
      const until = time + amount;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      time = until;
    }
  };
}

test("a user card selection waits for the matching detail identity and captures once", async () => {
  const target = card("Mews", "123"); target.title = "Product Builder - Fintech";
  let details = { jobId: "999", company: target.company, title: target.title, description: "Previous job description" };
  const app = harness([target], { scrape: () => details });
  app.states.delete("Mews"); app.click(target, { isTrusted: true }); await app.advance(0);
  assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_CAPTURE").length, 0);
  details = { ...details, jobId: "123", jobIdSource: "query" }; await app.advance(200);
  assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_CAPTURE").length, 0);
  details = { ...details, jobIdSource: "details", description: "Current description" }; await app.advance(200);
  await app.advance(1000);
  assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_CAPTURE").length, 1);
  app.click(target, { isTrusted: true }); await app.advance(200);
  assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_CAPTURE").length, 1);
  await app.advance(15_000);
  assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_NOT_SAVED").length, 0);
});

test("manual LinkedIn capture accepts only the narrow same-job Senior/Remote-Sr title alias without changing its displayed title", async () => {
  const target = card('Beacon Hill', '4480735630');
  target.title = 'Senior Authentication / Identity Security Engineer';
  let details = { jobId: '999', jobIdSource: 'details', company: 'Beacon Hill', title: target.title, description: 'Previous description' };
  const app = harness([target], { identityTitle, scrape: () => details, onSelect() {
    details = { ...details, jobId: '4480735630', title: 'Remote-Sr Authentication / Identity Security Engineer', description: 'Build secure production authentication and identity integrations.' };
  } });
  app.states.delete('Beacon Hill');
  app.click(target, { isTrusted: true });
  await app.advance(1500);
  const captures = app.messages.filter(message => message.type === 'KAI_TRACKER_CAPTURE');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].job.jobId, '4480735630');
  assert.equal(captures[0].job.title, 'Remote-Sr Authentication / Identity Security Engineer');
  assert.equal(target.title, 'Senior Authentication / Identity Security Engineer');
});

test("manual selection waits for changed description text even if the header and body DOM render first", async () => {
  const target = card("BigID", "102"); target.title = "Senior Software Engineer";
  let details = { jobId: "101", jobIdSource: "details", company: "BigID", title: target.title,
    description: "Design and build production data services and maintain automated tests.", descriptionRenderId: "previous-render" };
  const app = harness([target], { scrape: () => details, collector: { descriptionIsCurrent: require("../src/job-collector.js").descriptionIsCurrent } });
  app.states.delete("BigID"); app.click(target, { isTrusted: true });
  details = { ...details, jobId: "102", company: "BIGID", title: "SENIOR SOFTWARE ENGINEER" };
  await app.advance(1000);
  assert.equal(app.messages.filter(message => message.type === "KAI_TRACKER_CAPTURE").length, 0, "a header-only transition retains the previous body");
  details = { ...details, descriptionRenderId: "new-body-render" };
  await app.advance(30000);
  assert.equal(app.messages.filter(message => message.type === "KAI_TRACKER_CAPTURE").length, 0, "replacing only the body node cannot authorize old text");
  assert.equal(target.clicks, 0, "native dismissal waits for the job description to load");
  details = { ...details, description: "The selected role builds new production services and independently owns their release." };
  await app.advance(1500);
  const captures = app.messages.filter(message => message.type === "KAI_TRACKER_CAPTURE");
  assert.equal(captures.length, 1);
  assert.equal(captures[0].job.jobId, "102");
  assert.equal(captures[0].job.descriptionRenderId, "new-body-render");
  await app.advance(12_000);
  assert.equal(app.messages.filter(message => message.type === "KAI_TRACKER_CAPTURE").length, 1);
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
});

test("an intended manual selection reports an expired details check once without including another job's description", async () => {
  const target = card("Mews", "123");
  const app = harness([target], { scrape: () => ({ jobId: "999", company: "Other company", title: "Other role", description: "Unrelated private job description" }) });
  app.states.delete("Mews"); app.click(target, { isTrusted: true });
  await app.advance(95_000);
  const reports = app.messages.filter((message) => message.type === "KAI_TRACKER_NOT_SAVED");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reasonCode, "DETAILS_NOT_CONFIRMED"); assert.equal(reports[0].runId, undefined);
  assert.equal(reports[0].job.jobId, "123"); assert.equal(reports[0].job.company, "Mews");
  assert.equal(reports[0].job.sourceUrl, "https://www.linkedin.com/jobs/view/123/");
  assert.equal(reports[0].job.detailAvailability, "unavailable"); assert.equal(reports[0].job.description, undefined);
  await app.advance(15_000);
  assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_NOT_SAVED").length, 1);
  assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_CAPTURE").length, 0);
});

test("a slow manual description can load while hidden and Escape cancels another pending capture", async () => {
  const target = card("Mews", "123");
  let details = { jobId: "999", jobIdSource: "details", company: target.company, title: target.title, description: "Previous description" };
  const app = harness([target], { scrape: () => details });
  app.states.delete("Mews"); app.click(target, { isTrusted: true });
  app.document.hidden = true;
  await app.advance(60000);
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_NOT_SAVED"), false);
  details = { ...details, jobId: "123", description: "The current selected job description arrived after a slow network response." };
  await app.advance(1500);
  assert.equal(app.messages.filter(message => message.type === "KAI_TRACKER_CAPTURE").length, 1);

  const other = card("Other", "456");
  let pending = { ...details, jobId: "999" };
  const cancelled = harness([other], { scrape: () => pending });
  cancelled.states.delete("Other"); cancelled.click(other, { isTrusted: true });
  await cancelled.advance(20000);
  cancelled.events.keydown({ key: "Escape" });
  pending = { jobId: "456", jobIdSource: "details", company: other.company, title: other.title, description: "Correct late description" };
  await cancelled.advance(100000);
  assert.equal(cancelled.messages.some(message => message.type === "KAI_TRACKER_CAPTURE" || message.type === "KAI_TRACKER_NOT_SAVED"), false);
});

test("new job headers cannot capture the previous description or a recycled card identity", async () => {
  const target = card("Mews", "123");
  let details = { jobId: "999", company: target.company, title: target.title, description: "Previous description" };
  const app = harness([target], { scrape: () => details }); app.states.delete("Mews");
  app.click(target, { isTrusted: true }); details = { ...details, jobId: "123" };
  await app.advance(1000); assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_CAPTURE").length, 0);
  target.setAttribute("data-job-id", "777"); details = { ...details, jobId: "777", description: "Recycled job description" };
  await app.advance(1000); assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_CAPTURE").length, 0);
});

test("synthetic selection and native X controls never trigger research", async () => {
  const target = card("Mews", "123");
  const app = harness([target], { scrape: () => ({ jobId: "123", company: target.company, title: target.title, description: "Description" }) });
  app.states.delete("Mews"); app.click(target, { isTrusted: false }); app.click(target.button, { isTrusted: true });
  await app.advance(1000); assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_CAPTURE").length, 0);
});

test("clicks confirmed duplicate and banned jobs consecutively without dismissal delays", async () => {
  const jobs = [card("Duplicate", "1"), card("Banned", "2"), card("Allowed", "3")];
  const app = harness(jobs);
  app.states.set("Banned", "banned");
  app.states.delete("Allowed");
  await app.advance(250);
  assert.deepEqual(jobs.map((job) => job.clicks), [1, 1, 0]);
  assert.deepEqual(app.delays, [250, 0, 0]);
  assert.ok(app.messages.every((message) => message.refresh === false));
  app.refresh();
  await app.advance(10000);
  assert.deepEqual(jobs.map((job) => job.clicks), [1, 1, 0], "no repeated clicks, even if LinkedIn keeps the button");
});

test("rechecks company classification immediately before clicking", async () => {
  const job = card("Acme", "1");
  const app = harness([job], { respond(_message, count) {
    if (count === 2) return { ok: true, result: { companies: [{ company: "Acme", banned: false, duplicate: null }] } };
  } });
  await app.advance(250);
  assert.equal(job.clicks, 0);
  assert.equal(job.getAttribute("data-kai-flow-job-state"), null);
});

test("does not click cards recycled or removed before the final check completes", async () => {
  for (const change of [(job) => { job.company = "Different"; }, (job) => { job.setAttribute("data-job-id", "2"); }, (job) => { job.isConnected = false; }]) {
    const job = card("Acme", "1");
    const app = harness([job], { respond(_message, count) { if (count === 2) change(job); } });
    await app.advance(250);
    assert.equal(job.clicks, 0);
  }
});

test("skips hidden tabs and resumes without a dismissal delay when visible", async () => {
  const job = card("Acme", "1");
  const app = harness([job]);
  app.document.hidden = true;
  await app.advance(5000);
  assert.equal(job.clicks, 0);
  app.document.hidden = false;
  app.events.visibilitychange();
  await app.advance(0);
  assert.equal(job.clicks, 1);
});

test("ignores offscreen, covered, disabled, missing and Undo controls", async () => {
  for (const change of [(job) => { job.visible = false; }, (job) => { job.button.getBoundingClientRect = () => ({ left: 20, top: 1200, width: 20, height: 20 }); }, (job) => { job.button.disabled = true; }, (job) => { job.undo = true; }, (job) => { job.missingButton = true; }]) {
    const job = card("Acme", "1");
    const app = harness([job]);
    change(job);
    await app.advance(10000);
    assert.equal(job.clicks, 0);
    assert.deepEqual(app.delays, [250]);
  }
});

test("a card changed while the final check is in flight is never clicked", async () => {
  const job = card("Acme", "1");
  const app = harness([job], { respond(_message, count) {
    if (count === 2) job.company = "Changed";
  } });
  await app.advance(10000);
  assert.equal(job.clicks, 0);
});

test("a failed final check leaves the job untouched", async () => {
  const job = card("Acme", "1");
  const app = harness([job], { respond(_message, count) {
    if (count === 2) throw new Error("Disconnected");
  } });
  await app.advance(10000);
  assert.equal(job.clicks, 0);
});

test("clicking any open card selects it before clicking X once, including active jobs", async () => {
  for (const state of ["duplicate", "banned", "active"]) {
    const job = card("Acme", "1");
    const app = harness([job]);
    app.states.set("Acme", state);
    const event = app.click(job);
    app.click(job); // A fast second click must not toggle X again.
    assert.equal(job.clicks, 0, "dismissal waits until native selection finishes");
    assert.equal(job.selections, 2, "both original card clicks reach LinkedIn");
    assert.equal(app.messages.length, 0, "manual clicks require no company lookup");
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.stopped, false);
    await app.advance(0);
    assert.equal(job.clicks, 1);
    assert.equal(app.click(job).defaultPrevented, false);
    await app.advance(10000);
    assert.equal(job.clicks, 1);
  }
});

test("direct X clicks are remembered even if LinkedIn leaves the old button in place", async () => {
  const job = card("Acme", "1");
  const app = harness([job]);
  job.button.click();
  app.click(job);
  await app.advance(10000);
  assert.equal(job.clicks, 1);
});

test("clicking a card after automatic dismissal never clicks X again", async () => {
  const job = card("Acme", "1");
  const app = harness([job]);
  await app.advance(4000);
  assert.equal(job.clicks, 1);
  app.click(job);
  await app.advance(5000);
  assert.equal(job.clicks, 1);
});

test("card clicks leave Undo controls and modified navigation alone", async () => {
  const job = card("Acme", "1");
  const app = harness([job]);
  app.states.delete("Acme");
  await app.advance(250);
  assert.equal(app.click(job, { ctrlKey: true }).defaultPrevented, false);
  job.undo = true;
  assert.equal(app.click(job.button).defaultPrevented, false);
  assert.equal(app.click(job).defaultPrevented, false);
  await app.advance(10000);
  assert.equal(job.clicks, 0);
});

test("manual card closing works before classification and when the Sheet is offline", async () => {
  const job = card("Active", "1");
  const app = harness([job], { respond() { throw new Error("Offline"); } });
  assert.equal(app.click(job).defaultPrevented, false);
  assert.equal(job.selections, 1);
  await app.advance(0);
  assert.equal(job.clicks, 1);
  assert.equal(app.messages.length, 0);
  await app.advance(10000);
  app.click(job);
  assert.equal(job.clicks, 1);
});

test("a manual card click during an automatic check still clicks X only once", async () => {
  const job = card("Acme", "1");
  let finishCheck;
  const app = harness([job], { respond(_message, count) {
    if (count === 2) return new Promise((resolve) => { finishCheck = resolve; });
  } });
  await app.advance(250);
  assert.equal(typeof finishCheck, "function");
  app.click(job);
  await app.advance(0);
  assert.equal(job.clicks, 1);
  finishCheck();
  await app.advance(10000);
  assert.equal(job.clicks, 1);
});

test("selection that replaces or recycles the card cannot dismiss another job", async () => {
  for (const onSelect of [
    (job) => { job.isConnected = false; },
    (job) => { job.setAttribute("data-job-id", "replacement"); }
  ]) {
    const job = card("Acme", "1");
    const app = harness([job], { onSelect });
    app.click(job);
    await app.advance(0);
    assert.equal(job.selections, 1);
    assert.equal(job.clicks, 0);
  }
});

test("a direct X click before deferred card dismissal is never repeated", async () => {
  const job = card("Acme", "1");
  const app = harness([job]);
  app.click(job);
  job.button.click();
  await app.advance(0);
  assert.equal(job.selections, 1);
  assert.equal(job.clicks, 1);
});
