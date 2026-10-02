(function exposeJobCollector(root) {
  "use strict";
  function searchKey(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) ||
        !/^\/jobs\/search(?:-results)?\/?$/u.test(url.pathname)) return "";
      for (const name of ["currentJobId", "start", "eBP", "refId", "trackingId", "origin", "lipi"]) url.searchParams.delete(name);
      url.hash = "";
      url.searchParams.sort();
      return url.href;
    } catch { return ""; }
  }
  function reviewDelay(description, random = Math.random) {
    const words = String(description || "").trim().split(/\s+/u).filter(Boolean).length;
    // A short review, with more time for longer descriptions and bounded jitter.
    return Math.round(Math.min(90_000, Math.max(10_000, Math.min(80_000, words / (220 + random() * 100) * 60_000) * (0.85 + random() * 0.3))));
  }
  function create(adapter, { random = Math.random, now = () => Date.now(), schedule = setTimeout, unschedule = clearTimeout } = {}) {
    let current = null;
    const actionDelay = () => Math.round(900 + random() * 1600);
    const fingerprint = (job) => JSON.stringify([job.jobId, job.jobIdSource, job.company, job.title, job.description, job.applyUrl,
      job.workplaceType, job.isEasyApply, job.applicationsAvailable, job.applicationsClosed, job.posterName, job.descriptionEmails]);
    const active = (run) => current === run && !run.stopped;
    function check(run) {
      if (!active(run)) return false;
      if (adapter.searchKey() !== run.state.searchKey) throw new Error("The search changed. Job collection stopped.");
      return true;
    }
    function tick(run, delay) {
      return new Promise((resolve, reject) => {
        const wait = { timer: null, cancel: () => finish(false) };
        function finish(value, error) {
          if (!run.waits.delete(wait)) return;
          if (wait.timer !== null) unschedule(wait.timer);
          if (error) reject(error); else resolve(value);
        }
        run.waits.add(wait);
        if (adapter.wait) {
          Promise.resolve().then(() => adapter.wait(delay, run.state.id)).then(
            (value) => finish(value !== false), (error) => finish(false, error)
          );
        } else wait.timer = schedule(() => finish(true), delay);
      });
    }
    async function pause(run, milliseconds) {
      const deadline = now() + milliseconds;
      while (check(run)) {
        const remaining = deadline - now();
        if (remaining <= 0) return true;
        // Worker waits avoid hidden-page timer throttling. Each request stays
        // below the worker's idle timeout; late wakes never cause a burst.
        if (!await tick(run, Math.min(remaining, adapter.wait ? 20_000 : 250))) return false;
      }
      return false;
    }
    function matchingJob(run, record, previous) {
      if (!check(run) || !adapter.activeCard(record)) return null;
      const job = adapter.scrape();
      const key = (value) => String(value || "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
      if (!job || job.jobIdSource === "query" || String(job.jobId) !== record.id ||
        key(job.company) !== key(record.company) || key(job.title) !== key(record.title) || !job.description?.trim() ||
        (job.applicationsAvailable === false && !job.applicationsClosed) ||
        (previous && String(previous.jobId) !== record.id && previous.description && job.description === previous.description)) return null;
      return job;
    }
    async function details(run, record, previous) {
      let stable = "", stableAt = 0;
      // Each poll rechecks the exact selected job, even after a late wake.
      for (let elapsed = 0; elapsed < 15_000 && check(run); elapsed += 250) {
        if (!await pause(run, 250)) return null;
        let job;
        try { job = matchingJob(run, record, previous); } catch { job = null; }
        if (!job) { stable = ""; continue; }
        const value = fingerprint(job);
        if (value !== stable) { stable = value; stableAt = now(); continue; }
        if (now() - stableAt >= 500) return job;
      }
      return null;
    }
    async function collect(run, record) {
      if (!await adapter.allowed(record) || !check(run) || !adapter.activeCard(record)) { run.state.counts.skipped++; return; }
      if (!await pause(run, actionDelay())) return;
      await adapter.reveal(record);
      if (!await pause(run, actionDelay()) || !adapter.activeCard(record)) return;
      const previous = adapter.scrape();
      adapter.select(record);
      let job = await details(run, record, previous);
      if (!job) { run.state.counts.skipped++; return; }
      const reviewing = fingerprint(job);
      const delay = reviewDelay(job.description, random);
      adapter.status(`Reviewing ${job.company} — about ${Math.round(delay / 1000)} seconds.`, run.state);
      if (!await pause(run, delay)) return;
      // Both the card and details must still describe the reviewed job. A new
      // description needs another review; never submit the previous contents.
      job = matchingJob(run, record, previous);
      if (!job || fingerprint(job) !== reviewing) { run.state.counts.skipped++; return; }
      if (!await adapter.allowed(record) || !check(run)) return;
      job = matchingJob(run, record, previous);
      if (!job || fingerprint(job) !== reviewing) { run.state.counts.skipped++; return; }
      adapter.status(`Saving ${job.company}…`, run.state);
      const response = await adapter.capture(job, run.state.id);
      if (!response?.ok) {
        if (["DUPLICATE_COMPANY", "BANNED_COMPANY"].includes(response?.error?.code)) { run.state.counts.skipped++; return; }
        throw new Error(response?.error?.message || "The save could not be confirmed. Job collection stopped.");
      }
      const status = response.result?.status;
      if (status === "inserted") run.state.counts.saved++;
      else if (status === "researching") run.state.counts.researching++;
      else if (status === "skipped") run.state.counts.skipped++;
      else throw new Error("The save could not be confirmed. Job collection stopped.");
      if (check(run)) adapter.status(status === "researching" ? `Research queued for ${job.company}.` : status === "inserted"
        ? `Saved ${job.company}.` : `Skipped ${job.company}.`, run.state);
    }
    async function loop(run) {
      let message = "Finished — reached the last results page.";
      try {
        if (!await pause(run, actionDelay())) return;
        await adapter.top();
        let lastPage = run.state.pages?.at(-1) || "", bottomChecks = 0;
        let loadingWait = 0;
        while (check(run)) {
          if (!await pause(run, actionDelay())) break;
          const records = adapter.cards();
          const record = records.find((item) => item.id && !run.visited.has(item.id));
          if (record) {
            // A selected card is attempted once in this run, including a failed
            // details load. There is no automatic retry of an uncertain write.
            run.visited.add(record.id);
            await collect(run, record);
            bottomChecks = 0; loadingWait = 0;
            continue;
          }
          const more = await adapter.more();
          if (more === "loading") {
            loadingWait += 2500;
            if (loadingWait > 30_000) throw new Error("Results did not finish loading. Job collection stopped.");
            if (!await pause(run, 2500)) break;
            continue;
          }
          loadingWait = 0;
          if (more === "scrolled") { bottomChecks = 0; continue; }
          // Give lazy-loaded results two settled bottom observations before
          // choosing Next or declaring the end of the search.
          if (++bottomChecks < 2) continue;
          const page = adapter.pageKey();
          if (page !== lastPage) {
            if (run.pages.has(page)) throw new Error("The results repeated an earlier page. Job collection stopped.");
            lastPage = page; run.pages.add(page);
          }
          await checkpoint(run);
          if (!check(run)) break;
          const next = adapter.next();
          if (!next) break;
          adapter.status("Moving to the next results page…", run.state);
          await adapter.revealNext(next);
          if (!await pause(run, actionDelay()) || !check(run)) break;
          const before = adapter.cards().map((item) => item.id).join(",");
          await adapter.goNext(next);
          let changed = false, stable = "", stableAt = 0;
          for (let elapsed = 0; elapsed < 20_000 && check(run); elapsed += 250) {
            if (!await pause(run, 250)) break;
            const ids = adapter.cards().map((item) => item.id).join(",");
            if (!ids || ids === before || adapter.loading()) { stable = ""; continue; }
            if (ids !== stable) { stable = ids; stableAt = now(); continue; }
            if (now() - stableAt >= 750) { changed = true; break; }
          }
          if (!check(run)) break;
          if (!changed) throw new Error("The next page did not load. Job collection stopped.");
          if (run.pages.has(adapter.pageKey())) throw new Error("The results repeated an earlier page. Job collection stopped.");
          await adapter.top();
          bottomChecks = 0;
        }
        if (run.stopped) message = run.message;
      } catch (error) { message = error.message; }
      finally {
        if (run.stopped) message = run.message;
        run.stopped = true;
        for (const wait of run.waits) wait.cancel();
        run.waits.clear();
        try { await checkpoint(run); } catch { /* Do not retry Sheet writes. */ }
        try { await adapter.finished(run.state.id, message, run.state); } catch { /* Local Stop remains effective. */ }
        if (current === run) { current = null; adapter.status(message, run.state, true); }
      }
    }
    async function checkpoint(run) {
      run.state.visited = [...run.visited]; run.state.pages = [...run.pages];
      await adapter.checkpoint(run.state);
    }
    function start(state) {
      if (current) return false;
      const run = { state: { ...state, counts: { saved: 0, researching: 0, skipped: 0, ...state.counts } },
        visited: new Set(state.visited || []), pages: new Set(state.pages || []), waits: new Set(), stopped: false };
      current = run;
      adapter.status("Job collection started.", run.state);
      run.completion = loop(run);
      return true;
    }
    function stop(message = "Job collection stopped.") {
      const run = current;
      if (!run) return;
      run.stopped = true; run.message = message;
      adapter.status(message, run.state);
      for (const wait of run.waits) wait.cancel();
      run.waits.clear();
    }
    return Object.freeze({ start, stop, running: () => !!current, completion: () => current?.completion });
  }
  const api = Object.freeze({ create, searchKey, reviewDelay });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LinkedInJobCollector = api;
})(typeof globalThis === "undefined" ? this : globalThis);
