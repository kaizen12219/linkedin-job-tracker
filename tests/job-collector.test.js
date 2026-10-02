const assert = require("node:assert/strict");
const test = require("node:test");
const collector = require("../src/job-collector.js");
const SEARCH = "https://www.linkedin.com/jobs/search-results/?keywords=developer";
const row = (id, extra = {}) => ({ id: String(id), company: `Company ${id}`, title: "Engineer", active: true,
  description: `Vacancy ${id}. ` + "Useful job description ".repeat(30), ...extra });
function harness(pages, { state = {}, random = () => 0.5, failure = null, cycle = false, workerLag = null } = {}) {
  let time = 0, timerId = 0, page = 0, selected = { jobId: "999", description: "Previous job", title: "Other", company: "Other" }, hidden = false;
  const timers = new Map(), actions = [], captures = [], checkpoints = [], statuses = [], finishes = [];
  let search = collector.searchKey(SEARCH);
  const adapter = {
    searchKey: () => search, hidden: () => hidden, cards: () => pages[page], activeCard: (record) => record.active,
    async allowed(record) { return record.active && !record.filtered; },
    async top() { actions.push({ type: "top", time }); },
    async reveal(record) { actions.push({ type: "reveal", id: record.id, time }); },
    select(record) { actions.push({ type: "select", id: record.id, time }); selected = record; },
    scrape() {
      if (!selected.id) return selected;
      return { jobId: selected.id, jobIdSource: selected.queryOnly ? "query" : "details", company: selected.company, title: selected.title,
        description: selected.description, workplaceType: selected.workplaceType || "remote", isEasyApply: selected.easy || false,
        applicationsAvailable: true, sourceUrl: `${SEARCH}&start=${page * 25}&currentJobId=${selected.id}` };
    },
    async capture(job, runId) {
      captures.push({ job: structuredClone(job), time, runId });
      return failure || { ok: true, result: { status: job.isEasyApply || job.workplaceType === "hybrid" ? "researching" : "inserted" } };
    },
    async more() { return "bottom"; }, loading: () => false, pageKey: () => `page-${page}`,
    next: () => page + 1 < pages.length || cycle ? {} : null,
    async revealNext() { actions.push({ type: "reveal-next", time }); },
    async goNext() { actions.push({ type: "next", time }); page = (page + 1) % pages.length; },
    status(message, value, finished) { statuses.push({ message, state: structuredClone(value), finished, time }); },
    async checkpoint(value) { checkpoints.push(structuredClone(value)); },
    async finished(id, message, value) { finishes.push({ id, message, state: structuredClone(value) }); }
  };
  const workerWaits = [];
  if (workerLag !== null) adapter.wait = (delay) => {
    workerWaits.push(delay);
    return new Promise((resolve) => timers.set(++timerId, { at: time + delay + workerLag, callback: () => resolve(true) }));
  };
  const app = collector.create(adapter, { random, now: () => time,
    schedule(callback, delay) { timers.set(++timerId, { callback, at: time + delay }); return timerId; },
    unschedule(id) { timers.delete(id); } });
  app.start({ id: "run-1", searchKey: search, visited: [], pages: [], ...state });
  return { app, adapter, actions, captures, checkpoints, statuses, finishes, timers, workerWaits,
    hide(value) { hidden = value; }, changeSearch() { search += "&keywords=changed"; },
    async advance(amount) {
      const until = time + amount;
      await new Promise((resolve) => setImmediate(resolve));
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      time = until;
    }
  };
}
test("collection skips filtered/dismissed jobs, submits each active job once, and traverses to the final page", async () => {
  const h = harness([[row(1, { filtered: true }), row(2, { active: false }), row(3)], [row(3), row(4, { easy: true }), row(5, { workplaceType: "hybrid" })], [row(6)]]);
  await h.advance(500_000);
  assert.deepEqual(h.captures.map((entry) => entry.job.jobId), ["3", "4", "5", "6"]);
  assert.deepEqual(h.actions.filter((entry) => entry.type === "select").map((entry) => entry.id), ["3", "4", "5", "6"]);
  assert.equal(h.actions.filter((entry) => entry.type === "next").length, 2);
  assert.match(h.finishes[0].message, /last results page/);
  assert.equal(h.finishes[0].state.counts.saved, 2); assert.equal(h.finishes[0].state.counts.researching, 2);
  assert.equal(h.app.running(), false); assert.equal(h.timers.size, 0);
  for (const capture of h.captures) {
    const selected = h.actions.find((entry) => entry.type === "select" && entry.id === capture.job.jobId);
    assert.ok(capture.time - selected.time >= 10_000, "save waits for settling and a meaningful review");
  }
  assert.ok(h.checkpoints[0].visited.includes("3"), "progress is stored before Next");
});
test("review time grows with description size and stays within variable bounded pauses", () => {
  const short = collector.reviewDelay("word ".repeat(60), () => 0.5);
  const long = collector.reviewDelay("word ".repeat(350), () => 0.5);
  assert.ok(long > short);
  assert.notEqual(collector.reviewDelay("word ".repeat(350), () => 0), collector.reviewDelay("word ".repeat(350), () => 1));
  assert.notEqual(collector.reviewDelay("word ".repeat(3000), () => 0), collector.reviewDelay("word ".repeat(3000), () => 1));
  for (const size of [0, 60, 350, 3000]) for (const random of [0, 0.2, 0.5, 1]) {
    const delay = collector.reviewDelay("word ".repeat(size), () => random);
    assert.ok(delay >= 10_000 && delay <= 90_000);
  }
});
test("Stop cancels review immediately and prevents any save or subsequent selection", async () => {
  const h = harness([[row(1), row(2)]]);
  await h.advance(12_000);
  assert.match(h.statuses.at(-1).message, /Reviewing/);
  h.app.stop(); await h.advance(300_000);
  assert.equal(h.captures.length, 0); assert.equal(h.actions.filter((entry) => entry.type === "select").length, 1);
  assert.match(h.finishes[0].message, /stopped/);
});
test("hidden tabs continue paced collection without waiting for visibility", async () => {
  const h = harness([[row(1)]]);
  h.hide(true);
  await h.advance(90_000);
  assert.equal(h.captures.length, 1);
  assert.equal(h.statuses.some((entry) => entry.message.startsWith("Paused")), false);
  assert.ok(h.captures[0].time - h.actions.find((entry) => entry.type === "select").time >= 10_000);
});

test("late worker wakes count elapsed review time and recheck changed details before saving", async () => {
  const target = row(1);
  const h = harness([[target]], { workerLag: 4000 });
  h.hide(true); await h.advance(35_000);
  assert.match(h.statuses.at(-1).message, /Reviewing/);
  target.description = "Different job details arrived while the background worker was waiting.";
  await h.advance(300_000);
  assert.equal(h.captures.length, 0);
  assert.ok(h.workerWaits.every((delay) => delay > 0 && delay <= 20_000));
  assert.ok(h.workerWaits.length < 20, "late wakes must not stretch review into hundreds of nominal polling ticks");
});
test("changed descriptions, query-only identities and recycled cards never submit stale details", async () => {
  const current = row(1);
  const h = harness([[current, row(2, { queryOnly: true })]]);
  await h.advance(12_000); current.description = "Changed description after the review began.";
  await h.advance(300_000); assert.equal(h.captures.length, 0);
  const removed = row(3), k = harness([[removed]]);
  await k.advance(12_000); removed.active = false; await k.advance(300_000);
  assert.equal(k.captures.length, 0);
});
test("uncertain saves stop without retrying the job or moving to another page", async () => {
  const h = harness([[row(1), row(2)], [row(3)]], { failure: { ok: false, error: { code: "TRACKER_SAVE_UNCONFIRMED", message: "Unconfirmed save" } } });
  await h.advance(300_000);
  assert.equal(h.captures.length, 1); assert.equal(h.actions.some((entry) => entry.type === "next"), false);
  assert.match(h.finishes[0].message, /Unconfirmed save/);
  assert.deepEqual(h.finishes[0].state.visited, ["1"]);
});
test("resume preserves attempted jobs and completed pages; repeated pages and changed searches stop", async () => {
  const resumed = harness([[row(1)], [row(2)]], { state: { visited: ["1"], pages: ["page-0"] } });
  await resumed.advance(300_000); assert.deepEqual(resumed.captures.map((entry) => entry.job.jobId), ["2"]);
  const repeated = harness([[row(1)], [row(2)]], { cycle: true });
  await repeated.advance(300_000);
  assert.equal(repeated.captures.length, 2); assert.match(repeated.finishes[0].message, /repeated/);
  const changed = harness([[row(1), row(2)]]); await changed.advance(12_000); changed.changeSearch(); await changed.advance(300_000);
  assert.equal(changed.captures.length, 0); assert.match(changed.finishes[0].message, /search changed/);
});
test("search identity ignores job selection, tracking and pagination but retains search filters", () => {
  assert.equal(collector.searchKey(`${SEARCH}&start=25&currentJobId=123&trackingId=abc`), collector.searchKey(SEARCH));
  assert.notEqual(collector.searchKey(`${SEARCH}&f_WT=2`), collector.searchKey(SEARCH));
  assert.equal(collector.searchKey("https://www.linkedin.com/jobs/view/123"), "");
  assert.equal(collector.searchKey("https://example.com/jobs/search/"), "");
});
