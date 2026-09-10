const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONTENT = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");

function card(company, id) {
  const attributes = new Map([["data-job-id", id]]);
  const result = {
    company, title: "Engineer", isConnected: true, clicks: 0, visible: true,
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
    document,
    window: { innerWidth: 1000, innerHeight: 800 },
    MutationObserver: class { observe() {} },
    Math: Object.assign(Object.create(Math), { random: options.random || (() => 0.5) }),
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

test("clicks real dismiss controls one at a time with a fresh randomized pause", async () => {
  const jobs = [card("Duplicate", "1"), card("Banned", "2"), card("Allowed", "3")];
  const random = [0, 0.999];
  const app = harness(jobs, { random: () => random.shift() ?? 0.5 });
  app.states.set("Banned", "banned");
  app.states.delete("Allowed");
  await app.advance(250);
  assert.deepEqual(jobs.map((job) => job.clicks), [0, 0, 0]);
  await app.advance(1499);
  assert.equal(jobs[0].clicks, 0);
  await app.advance(1);
  assert.deepEqual(jobs.map((job) => job.clicks), [1, 0, 0]);
  await app.advance(4496);
  assert.equal(jobs[1].clicks, 0);
  await app.advance(1);
  assert.deepEqual(jobs.map((job) => job.clicks), [1, 1, 0]);
  assert.deepEqual(app.delays, [250, 1500, 4497]);
  assert.ok(app.messages.every((message) => message.refresh === false));
  app.refresh();
  await app.advance(10000);
  assert.deepEqual(jobs.map((job) => job.clicks), [1, 1, 0], "no repeated clicks, even if LinkedIn keeps the button");
});

test("rechecks company classification immediately before clicking", async () => {
  const job = card("Acme", "1");
  const app = harness([job]);
  await app.advance(250);
  app.states.delete("Acme");
  await app.advance(3000);
  assert.equal(job.clicks, 0);
  assert.equal(job.getAttribute("data-kai-flow-job-state"), null);
});

test("does not click recycled or removed cards during the delay", async () => {
  for (const change of [(job) => { job.company = "Different"; }, (job) => { job.setAttribute("data-job-id", "2"); }, (job) => { job.isConnected = false; }]) {
    const job = card("Acme", "1");
    const app = harness([job]);
    await app.advance(250);
    change(job);
    await app.advance(5000);
    assert.equal(job.clicks, 0);
  }
});

test("skips hidden tabs and resumes with a full pause when visible", async () => {
  const job = card("Acme", "1");
  const app = harness([job]);
  await app.advance(250);
  app.document.hidden = true;
  await app.advance(5000);
  assert.equal(job.clicks, 0);
  app.document.hidden = false;
  app.events.visibilitychange();
  await app.advance(2999);
  assert.equal(job.clicks, 0);
  await app.advance(1);
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

test("clicking any open card clicks X once, including active jobs, and cancels its automatic attempt", async () => {
  for (const state of ["duplicate", "banned", "active"]) {
    const job = card("Acme", "1");
    const app = harness([job]);
    app.states.set("Acme", state);
    await app.advance(250);
    const event = app.click(job);
    app.click(job); // A fast second click must not toggle X again.
    assert.equal(job.clicks, 1, "manual card clicks take effect immediately");
    assert.equal(app.messages.length, 1, "manual clicks require no company lookup");
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
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
  await app.advance(250);
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
  assert.equal(app.click(job).defaultPrevented, true);
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
  await app.advance(3250);
  assert.equal(typeof finishCheck, "function");
  app.click(job);
  assert.equal(job.clicks, 1);
  finishCheck();
  await app.advance(10000);
  assert.equal(job.clicks, 1);
});
