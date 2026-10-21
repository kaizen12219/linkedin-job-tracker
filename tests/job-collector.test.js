const assert = require("node:assert/strict");
const test = require("node:test");
const collector = require("../src/job-collector.js");
const SEARCH = "https://www.linkedin.com/jobs/search-results/?keywords=developer";
const row = (id, extra = {}) => ({ id: String(id), company: `Company ${id}`, title: "Engineer", active: true,
  description: `Vacancy ${id}. ` + "Useful job description ".repeat(30), ...extra });
function harness(pages, { state = {}, random = () => 0.5, failure = null, cycle = false, workerLag = null, reportFailures = false, reportError = false,
  sourceUrl = SEARCH, jobUrl = null, changeSelectionUrl = false } = {}) {
  let time = 0, timerId = 0, page = 0, selected = { jobId: "999", description: "Previous job", title: "Other", company: "Other" }, hidden = false;
  const timers = new Map(), actions = [], captures = [], checkpoints = [], statuses = [], finishes = [], reports = [];
  let search = collector.searchKey(sourceUrl);
  const adapter = {
    searchKey: () => search, hidden: () => hidden, cards: () => pages[page], activeCard: (record) => record.active,
    async allowed(record) { return record.active && !record.filtered; },
    async top() { actions.push({ type: "top", time }); },
    async reveal(record) { actions.push({ type: "reveal", id: record.id, time }); },
    select(record) {
      actions.push({ type: "select", id: record.id, time }); selected = record;
      if (changeSelectionUrl) search = collector.searchKey(jobUrl(record, page));
    },
    scrape() {
      if (!selected.id) return selected;
      return { jobId: selected.id, jobIdSource: selected.queryOnly ? "query" : "details", company: selected.company, title: selected.title,
        description: selected.description, workplaceType: selected.workplaceType || "remote", isEasyApply: selected.easy || false,
        applicationsAvailable: true, sourceUrl: jobUrl ? jobUrl(selected, page) : `${SEARCH}&start=${page * 25}&currentJobId=${selected.id}` };
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
  if (reportFailures) adapter.notSaved = async (record, outcome, runId) => {
    reports.push({ id: record.id, ...structuredClone(outcome), runId, time });
    if (reportError) throw new Error("The report folder is unavailable.");
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
  return { app, adapter, actions, captures, checkpoints, statuses, finishes, reports, timers, workerWaits,
    get time() { return time; },
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
    assert.ok(capture.time - selected.time >= 5_000, "save waits for settling and a meaningful review");
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
    assert.ok(delay >= 5_000 && delay <= 45_000);
  }
});
test("a different job must load its own changed description even when a replacement DOM token is fresh", () => {
  const previous = { jobId: "101", jobIdSource: "details", company: "BigID", title: "Senior IT Operations Engineer",
    description: "Build and maintain production automation and identity systems.", descriptionRenderId: "description:1" };
  const current = { ...previous, jobId: "102", company: "BIGID", descriptionRenderId: "description:2" };
  assert.equal(collector.descriptionIsCurrent(current, previous), false);
  for (const update of [
    { descriptionRenderId: previous.descriptionRenderId }, { descriptionRenderId: "" }, { descriptionRenderId: undefined },
    { company: "Another company" }, { title: "Another role" }, { jobIdSource: "query" }, { jobIdSource: "page" }
  ]) assert.equal(collector.descriptionIsCurrent({ ...current, ...update }, previous), false, JSON.stringify(update));
  assert.equal(collector.descriptionIsCurrent(current, { ...previous, descriptionRenderId: undefined }), false);
  assert.equal(collector.descriptionIsCurrent(current, { ...previous, jobIdSource: "query" }), false);
});
test("ordinary changed descriptions and the same selected job retain their existing readiness behavior", () => {
  const previous = { jobId: "101", description: "Previous description" };
  assert.equal(collector.descriptionIsCurrent({ jobId: "101", description: previous.description }, previous), true);
  assert.equal(collector.descriptionIsCurrent({ jobId: "102", description: "New description" }, previous), true);
  assert.equal(collector.descriptionIsCurrent({ jobId: "102", description: previous.description }, previous), false);
  assert.equal(collector.descriptionIsCurrent({ jobId: "102", description: "  Previous\n description  " }, previous), false);
});

test("only an adapter explicitly opting into a title equivalence can collect a narrow alias", async () => {
  const h = harness([[row(1, { title: 'Senior Engineer' }), row(2)]], { reportFailures: true });
  const scrape = h.adapter.scrape;
  h.adapter.scrape = () => { const job = scrape(); return job.jobId === '1' ? { ...job, title: 'Remote-Sr Engineer' } : job; };
  h.adapter.titleMatches = (actual, expected) => actual === expected || (actual === 'Remote-Sr Engineer' && expected === 'Senior Engineer');
  await h.advance(300000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), ['1', '2']);
  assert.equal(h.captures[0].job.title, 'Remote-Sr Engineer');
  assert.equal(h.reports.length, 0);
});

test("Jobright retains exact title matching when its adapter has no equivalence opt-in", async () => {
  const first = '68c123456789abcdef012301', second = '68c123456789abcdef012302';
  const h = harness([[row(first, { title: 'Senior Engineer' }), row(second)]], { reportFailures: true,
    sourceUrl: 'https://jobright.ai/jobs/recommend', jobUrl: record => `https://jobright.ai/jobs/info/${record.id}` });
  const scrape = h.adapter.scrape;
  h.adapter.scrape = () => { const job = scrape(); return job.jobId === first ? { ...job, title: 'Remote-Sr Engineer' } : job; };
  await h.advance(300000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), [second]);
  assert.equal(h.reports[0].id, first);
  assert.equal(h.reports[0].code, 'DETAILS_NOT_CONFIRMED');
});

test("a permitted title alias cannot authorize the previous job's unchanged description", async () => {
  const h = harness([[row(1, { title: 'Senior Engineer', description: 'Previous job' }), row(2)]], { reportFailures: true });
  const scrape = h.adapter.scrape;
  h.adapter.scrape = () => { const job = scrape(); return job.jobId === '1' ? { ...job, title: 'Remote-Sr Engineer' } : job; };
  h.adapter.titleMatches = (actual, expected) => actual === expected || (actual === 'Remote-Sr Engineer' && expected === 'Senior Engineer');
  await h.advance(300000);
  assert.deepEqual(h.captures.map(capture => capture.job.jobId), ['2']);
  assert.match(h.reports[0].reason, /previous job/u);
});

test("slow 25- and 60-second body responses wait for a changed description before review and keep collecting", async () => {
  for (const delay of [25_000, 60_000]) {
    const target = row(1, { description: "Previous job" });
    const h = harness([[target, row(2)]], { reportFailures: true });
    await h.advance(10_000);
    const selectedAt = h.actions.find(action => action.type === "select").time;
    assert.equal(h.captures.length, 0);
    await h.advance(selectedAt + delay - h.time);
    assert.equal(h.captures.length, 0);
    target.description = "Build the newly selected production service and its automated tests.";
    const changedAt = h.time;
    await h.advance(300_000);
    assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["1", "2"]);
    assert.equal(h.captures[0].job.description, target.description);
    assert.ok(h.captures[0].time >= changedAt + 500 + collector.reviewDelay(target.description, () => .5));
    assert.equal(h.reports.length, 0);
    assert.ok(h.statuses.some(entry => entry.message.startsWith("Waiting for") && /previous job's description/.test(entry.message)));
  }
});

test("fresh replacement markers and new headers cannot authorize an unchanged previous body", async () => {
  const first = row(1, { description: "Previous job" });
  const h = harness([[first, row(2)]], { reportFailures: true });
  const scrape = h.adapter.scrape;
  let token = 0;
  h.adapter.scrape = () => ({ ...scrape(), descriptionRenderId: `replacement-${++token}` });
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["2"]);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].id, "1");
  assert.match(h.reports[0].reason, /previous job's description/);
  assert.match(h.reports[0].reason, /90-second/);
  assert.equal(h.reports[0].job, undefined);
});

test("a permanently missing body times out by elapsed wall time and continues with the next job", async () => {
  const h = harness([[row(1, { description: "" }), row(2)]], { reportFailures: true, workerLag: 4_000 });
  await h.advance(400_000);
  const selectedAt = h.actions.find(action => action.type === "select" && action.id === "1").time;
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["2"]);
  assert.equal(h.reports.length, 1);
  assert.match(h.reports[0].reason, /90-second/);
  assert.doesNotMatch(h.reports[0].reason, /Review diagnostics/u, "a readiness-only failure has no review measurements");
  assert.ok(h.reports[0].time - selectedAt >= 90_000);
  assert.ok(h.reports[0].time - selectedAt <= 95_000, "late wakes use one actual deadline rather than 180 nominal polls");
  assert.ok(h.workerWaits.length < 50);
});

test("Stop and a changed search interrupt a slow readiness wait before any capture", async () => {
  for (const stop of [true, false]) {
    const h = harness([[row(1, { description: "Previous job" }), row(2)]], { reportFailures: true });
    await h.advance(20_000);
    assert.ok(h.statuses.some(entry => entry.message.startsWith("Waiting for")));
    if (stop) h.app.stop(); else h.changeSearch();
    await h.advance(501);
    assert.equal(h.app.running(), false);
    assert.equal(h.captures.length, 0);
    assert.equal(h.actions.filter(action => action.type === "select").length, 1);
    assert.match(h.finishes[0].message, stop ? /stopped/ : /search changed/);
  }
});

test("continuously changing descriptions exhaust one 180-second review budget without writing or blocking the next job", async () => {
  const target = row(1, { description: "Initial ".repeat(300) });
  const h = harness([[target, row(2)]], { reportFailures: true });
  for (let revision = 0; revision < 10; revision++) {
    await h.advance(20_000);
    target.description = `Revision ${revision} ` + "Changing production requirements ".repeat(300);
  }
  await h.advance(300_000);
  const selectedAt = h.actions.find(action => action.type === "select" && action.id === "1").time;
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["2"]);
  assert.equal(h.reports.length, 1);
  assert.match(h.reports[0].reason, /180-second/);
  assert.ok(h.reports[0].time - selectedAt <= 180_000);
  assert.ok(h.statuses.filter(entry => entry.message.startsWith("Reviewing Company 1")).length > 1);
  assert.match(h.reports[0].reason, /changed fields=description/u);
});

test("failure-only review diagnostics identify Apply URL drift without recording URL or job values", async () => {
  const h = harness([[row(1), row(2)]], { reportFailures: true });
  const scrape = h.adapter.scrape, status = h.adapter.status;
  let revision = 0;
  h.adapter.scrape = () => {
    const job = scrape();
    return job.jobId === "1" ? { ...job, applyUrl: `https://private-applicant.invalid/apply?secret=do-not-log-${revision}` } : job;
  };
  h.adapter.status = (...args) => {
    status(...args);
    if (args[0].startsWith("Reviewing Company 1")) revision++;
  };
  await h.advance(400_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["2"]);
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0].code, "DETAILS_NOT_CONFIRMED");
  const reason = h.reports[0].reason;
  assert.match(reason, /fingerprint changed during review/u);
  assert.match(reason, /180-second/u); assert.match(reason, /Review diagnostics: attempts=\d+/u);
  assert.match(reason, /changed fields=applyUrl\./u);
  assert.match(reason, /details became unavailable=no/u);
  assert.doesNotMatch(reason, /https:|private-applicant|do-not-log|Useful job description/u);
  assert.ok(reason.length <= 2000); assert.ok(reason.slice(reason.indexOf(" Review diagnostics:")).length <= 700);
});

test("review diagnostics distinguish a late wake from an observed fingerprint change", async () => {
  const h = harness([[row(1), row(2)]], { reportFailures: true, workerLag: 0 });
  const wait = h.adapter.wait, status = h.adapter.status;
  let reviewingFirst = false, delayed = false, lateTimer = 1000000;
  h.adapter.status = (...args) => { status(...args); if (args[0].startsWith("Reviewing Company 1")) reviewingFirst = true; };
  h.adapter.wait = (...args) => {
    if (!reviewingFirst || delayed) return wait(...args);
    delayed = true;
    return new Promise(resolve => h.timers.set(++lateTimer, { at: h.time + args[0] + 200_000, callback: () => resolve(true) }));
  };
  await h.advance(500_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["2"]);
  const reason = h.reports[0].reason;
  assert.match(reason, /attempts=1/u); assert.match(reason, /180-second/u);
  const requested = Number(reason.match(/last requested ms=(\d+)/u)[1]);
  const elapsed = Number(reason.match(/last elapsed ms=(\d+)/u)[1]);
  assert.ok(elapsed > requested); assert.match(reason, /late wake ms=200000/u);
  assert.match(reason, /changed fields=none \(no fingerprint delta observed\)/u);
  assert.match(reason, /details became unavailable=no/u);
});

test("stable successful reviews do not add diagnostic fields or failure messages", async () => {
  const h = harness([[row(1)]], { reportFailures: true });
  await h.advance(100_000);
  assert.equal(h.captures.length, 1); assert.equal(h.reports.length, 0);
  assert.equal(h.statuses.filter(entry => entry.message.startsWith("Reviewing")).length, 1);
  assert.equal(h.statuses.some(entry => /Review diagnostics/u.test(entry.message)), false);
  assert.equal(Object.keys(h.captures[0].job).some(key => /diagnostic|review/i.test(key)), false);
});

test("review diagnostics record details becoming unavailable without inventing a fingerprint delta", async () => {
  const target = row(1), h = harness([[target, row(2)]], { reportFailures: true });
  const status = h.adapter.status;
  h.adapter.status = (...args) => { status(...args); if (args[0].startsWith("Reviewing Company 1")) target.description = ""; };
  await h.advance(400_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["2"]);
  assert.match(h.reports[0].reason, /description is not readable/u);
  assert.match(h.reports[0].reason, /details became unavailable=yes/u);
  assert.match(h.reports[0].reason, /changed fields=none \(no fingerprint delta observed\)/u);
});

test("Jobright also waits for its own changed body and cannot accept identical stale text under a new ID", async () => {
  const id = "68f01234567890abcdef1234", next = "68f01234567890abcdef1235";
  const target = row(id, { description: "Previous job" });
  const h = harness([[target, row(next)]], {
    sourceUrl: "https://jobright.ai/jobs/recommend?location=United+States", changeSelectionUrl: true,
    jobUrl: record => `https://jobright.ai/jobs/info/${record.id}?location=United+States`, reportFailures: true
  });
  await h.advance(60_000);
  assert.equal(h.captures.length, 0);
  target.description = "Build the newly selected Jobright service and its production integrations.";
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), [id, next]);
  assert.equal(h.reports.length, 0);
  assert.equal(h.captures[0].job.description, target.description);
});

test("lazy description preparation runs only for an exact selected header and at most once per second", async () => {
  const target = row(1, { description: "Previous job" });
  const h = harness([[target]], { reportFailures: true });
  const scrape = h.adapter.scrape;
  h.adapter.scrape = () => {
    const job = scrape();
    return job?.jobId === "1" && h.time < 20_000 ? { ...job, jobId: "999" } : job;
  };
  const prepared = [];
  h.adapter.prepareDetails = record => {
    prepared.push({ id: record.id, time: h.time });
    if (prepared.length === 3) target.description = "The selected job's newly mounted production engineering description.";
  };
  await h.advance(19_000);
  assert.equal(prepared.length, 0, "a wrong rendered job header must never authorize moving its detail pane");
  await h.advance(300_000);
  assert.equal(prepared.length, 3);
  assert.ok(prepared.every((entry, index) => entry.id === "1" && entry.time >= 20_000 && (!index || entry.time - prepared[index - 1].time >= 1000)));
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].job.description, target.description);
  assert.equal(h.reports.length, 0);
});
test("short-job pacing reaches research in under twelve seconds and continues to Next", async () => {
  for (const random of [() => 0, () => 1]) {
    const h = harness([[row(1, { description: 'Build production software.', easy: true })], [row(2)]], { random });
    await h.advance(12_000);
    assert.equal(h.captures.length, 1);
    assert.equal(h.captures[0].job.jobId, '1');
    assert.ok(h.captures[0].time >= 5_000 && h.captures[0].time <= 12_000);
    assert.ok(h.actions.find(action => action.type === 'top').time >= 450);
    assert.ok(h.actions.find(action => action.type === 'top').time <= 1250);
    await h.advance(150_000);
    assert.deepEqual(h.captures.map(entry => entry.job.jobId), ['1', '2']);
    assert.equal(h.actions.filter(action => action.type === 'next').length, 1);
    assert.equal(h.finishes[0].state.counts.researching, 1);
    assert.match(h.finishes[0].message, /last results page/);
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
  assert.ok(h.captures[0].time - h.actions.find((entry) => entry.type === "select").time >= 5_000);
});

test("late worker wakes count elapsed review time and fully review changed details before saving", async () => {
  const target = row(1);
  const h = harness([[target]], { workerLag: 4000 });
  h.hide(true); await h.advance(35_000);
  assert.match(h.statuses.at(-1).message, /Reviewing/);
  target.description = "Different job details arrived while the background worker was waiting.";
  await h.advance(300_000);
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].job.description, target.description);
  assert.equal(h.statuses.filter(entry => entry.message.startsWith("Reviewing")).length, 2);
  assert.ok(h.workerWaits.every((delay) => delay > 0 && delay <= 20_000));
  assert.ok(h.workerWaits.length < 20, "late wakes must not stretch review into hundreds of nominal polling ticks");
});
test("changed descriptions are reviewed again while query-only identities and recycled cards never submit", async () => {
  const current = row(1);
  const h = harness([[current, row(2, { queryOnly: true })]]);
  await h.advance(12_000); current.description = "Changed description after the review began.";
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(entry => entry.job.jobId), ["1"]);
  assert.equal(h.captures[0].job.description, current.description);
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
test("a failed detail transition reopens once before review and captures each job once", async () => {
  const h = harness([[row(1), row(2)]], { reportFailures: true });
  const scrape = h.adapter.scrape;
  let recovered = false;
  const reopened = [];
  h.adapter.scrape = () => recovered ? scrape() : null;
  h.adapter.detailFailure = () => "Jobright's selected job details are still changing.";
  h.adapter.recoverDetails = async (record) => { reopened.push(record.id); recovered = true; };
  await h.advance(300_000);
  assert.deepEqual(reopened, ["1"]);
  assert.deepEqual(h.captures.map(({ job }) => job.jobId), ["1", "2"]);
  assert.equal(h.reports.length, 0);
  assert.equal(h.app.running(), false);
});
test("permanently unreadable details get one reopening, a precise report, and collection continues", async () => {
  const h = harness([[row(1), row(2)]], { reportFailures: true });
  const scrape = h.adapter.scrape;
  const reopened = [];
  h.adapter.scrape = () => { const job = scrape(); return job?.jobId === "1" ? null : job; };
  h.adapter.detailFailure = () => "The rendered panel metadata still identifies a different job.";
  h.adapter.recoverDetails = async (record) => reopened.push(record.id);
  await h.advance(300_000);
  assert.deepEqual(reopened, ["1"]);
  assert.deepEqual(h.captures.map(({ job }) => job.jobId), ["2"]);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].code, "DETAILS_NOT_CONFIRMED");
  assert.match(h.reports[0].reason, /panel metadata/);
  assert.equal(h.app.running(), false);
});
test("detail recovery is never invoked after an uncertain capture", async () => {
  const h = harness([[row(1), row(2)]], { failure: { ok: false, error: { code: "TRACKER_SAVE_UNCONFIRMED", message: "Unconfirmed save" } } });
  let reopened = 0;
  h.adapter.recoverDetails = async () => reopened++;
  await h.advance(300_000);
  assert.equal(reopened, 0);
  assert.equal(h.captures.length, 1);
  assert.match(h.finishes[0].message, /Unconfirmed save/);
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

test("Jobright search identity canonicalizes recommendation/detail paths and keeps committed filters", () => {
  const canonical = "https://jobright.ai/jobs/recommend?location=United+States&remote=true";
  assert.equal(collector.searchKey("https://www.jobright.ai/jobs/recommend/?remote=true&location=United+States#results"), canonical);
  assert.equal(collector.searchKey("https://jobright.ai/jobs/info/68f01234567890abcdef1234?remote=true&location=United+States#details"), canonical);
  assert.notEqual(collector.searchKey("https://jobright.ai/jobs/recommend?location=United+Kingdom&remote=true"), canonical);
  for (const url of ["https://jobright.ai/jobs/info/123", "https://jobright.ai/jobs/info/", "https://jobright.ai/jobs/search", "https://subdomain.jobright.ai/jobs/recommend", "https://jobright.ai.evil.test/jobs/recommend"]) {
    assert.equal(collector.searchKey(url), "", url);
  }
});

test("Jobright hexadecimal job identities progress once through the full feed while selection changes the detail URL", async () => {
  const ids = ["68f01234567890abcdef1234", "68f01234567890abcdef1235", "68f01234567890abcdef1236"];
  const sourceUrl = "https://www.jobright.ai/jobs/recommend?location=United+States&remote=true";
  const h = harness([[row(ids[0]), row(ids[1], { filtered: true })], [row(ids[0]), row(ids[2])]], {
    sourceUrl, changeSelectionUrl: true,
    jobUrl: record => `https://jobright.ai/jobs/info/${record.id}?remote=true&location=United+States`
  });
  await h.advance(500_000);
  assert.deepEqual(h.captures.map(({ job }) => job.jobId), [ids[0], ids[2]]);
  assert.ok(h.captures.every(({ job }) => job.jobIdSource === "details" && job.sourceUrl.includes(`/jobs/info/${job.jobId}`)));
  assert.deepEqual(h.actions.filter(action => action.type === "select").map(action => action.id), [ids[0], ids[2]]);
  assert.equal(h.actions.filter(action => action.type === "next").length, 1);
  assert.equal(h.finishes[0].state.counts.saved, 2);
  assert.match(h.finishes[0].message, /last results page/);
  assert.equal(h.app.running(), false);
  assert.equal(h.timers.size, 0);
});

test("Jobright collection stops when the committed search changes before a reviewed job saves", async () => {
  const h = harness([[row("68f01234567890abcdef1234"), row("68f01234567890abcdef1235")]], {
    sourceUrl: "https://jobright.ai/jobs/recommend?location=United+States",
    jobUrl: record => `https://jobright.ai/jobs/info/${record.id}?location=United+States`
  });
  await h.advance(12_000);
  h.changeSearch();
  await h.advance(300_000);
  assert.equal(h.captures.length, 0);
  assert.match(h.finishes[0].message, /search changed/);
});
test("Jobright collection continues when opening cards removes homepage tracking parameters", async () => {
  const ids = ["68f01234567890abcdef1234", "68f01234567890abcdef1235"];
  const h = harness([[row(ids[0]), row(ids[1])]], {
    sourceUrl: "https://jobright.ai/jobs/recommend?from=homepage&id=",
    changeSelectionUrl: true,
    jobUrl: record => `https://jobright.ai/jobs/info/${record.id}`
  });
  await h.advance(300_000);
  assert.deepEqual(h.captures.map(({ job }) => job.jobId), ids);
  assert.equal(h.finishes[0].state.counts.saved, 2);
  assert.match(h.finishes[0].message, /last results page/);
  assert.equal(h.app.running(), false);
});
test("attempted filtered cards and unverified details are reported once without changing collection", async () => {
  const h = harness([[row(1, { filtered: true }), row(2, { active: false }), row(3, { queryOnly: true }), row(4)]], { reportFailures: true });
  await h.advance(500_000);
  assert.deepEqual(h.reports.map(({ id, code, runId }) => ({ id, code, runId })), [
    { id: "1", code: "CARD_UNAVAILABLE", runId: "run-1" },
    { id: "2", code: "CARD_UNAVAILABLE", runId: "run-1" },
    { id: "3", code: "DETAILS_NOT_CONFIRMED", runId: "run-1" }
  ]);
  assert.ok(h.reports.every((report) => !report.job), "unmatched details are never included in a report");
  assert.deepEqual(h.captures.map(({ job }) => job.jobId), ["4"]);
  assert.match(h.finishes[0].message, /last results page/);
});
test("a description arriving during review receives a complete second review before capture", async () => {
  const current = row(1), original = current.description;
  const h = harness([[current]], { reportFailures: true });
  await h.advance(12_000); current.description = "Changed details while this job was being reviewed.";
  await h.advance(300_000);
  assert.equal(h.reports.length, 0);
  assert.equal(h.captures.length, 1);
  assert.notEqual(h.captures[0].job.description, original);
  assert.equal(h.captures[0].job.description, current.description);
  const reviews = h.statuses.filter(entry => entry.message.startsWith("Reviewing"));
  assert.equal(reviews.length, 2);
  assert.ok(h.captures[0].time - reviews[1].time >= collector.reviewDelay(current.description, () => .5));
});
test("reporting failures cannot stop collection or retry a capture", async () => {
  const h = harness([[row(1, { filtered: true }), row(2)]], { reportFailures: true, reportError: true });
  await h.advance(300_000);
  assert.equal(h.reports.length, 1);
  assert.deepEqual(h.captures.map(({ job }) => job.jobId), ["2"]);
  assert.match(h.finishes[0].message, /last results page/);
});
