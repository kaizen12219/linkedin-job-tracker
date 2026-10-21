(function exposeJobCollector(root) {
  "use strict";
  function searchKey(value) {
    const policy = root.JobCapturePolicy || (typeof require === "function" ? require("./capture-policy.js") : null);
    if (policy) return policy.sourceSearchKey(value);
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
    // Half the original review time, with the same description sizing and jitter.
    return Math.round(0.5 * Math.min(90_000, Math.max(10_000, Math.min(80_000, words / (220 + random() * 100) * 60_000) * (0.85 + random() * 0.3))));
  }
  function descriptionIsCurrent(job, previous) {
    // A replacement node or new header does not prove that the selected
    // posting's body has arrived. Wait for the actual description to change.
    const description = (value) => String(value || "").replace(/\s+/gu, " ").trim();
    return !previous || String(previous.jobId) === String(job?.jobId) || !description(previous.description) || description(job?.description) !== description(previous.description);
  }
  function create(adapter, { random = Math.random, now = () => Date.now(), schedule = setTimeout, unschedule = clearTimeout } = {}) {
    let current = null;
    const actionDelay = () => Math.round(450 + random() * 800);
    const fingerprintFields = ["jobId", "jobIdSource", "company", "title", "description", "applyUrl", "workplaceType", "isEasyApply",
      "applicationsAvailable", "applicationsClosed", "posterName", "descriptionEmails"];
    const fingerprint = (job) => JSON.stringify(fingerprintFields.map(field => job[field]));
    const stabilityFailure = "The selected job's details did not remain stable long enough to verify.";
    function observeDetails(diagnostics, job) {
      if (!diagnostics) return;
      if (!job) {
        if (diagnostics.lastValues) diagnostics.detailsBecameUnavailable = true;
        return;
      }
      const values = fingerprintFields.map(field => JSON.stringify([job[field]]));
      if (diagnostics.lastValues) for (let index = 0; index < fingerprintFields.length; index++) {
        if (values[index] !== diagnostics.lastValues[index]) diagnostics.changedFields.add(fingerprintFields[index]);
      }
      diagnostics.lastValues = values;
    }
    function reviewFailureReason(reason, diagnostics, reachedLimit) {
      if (!reachedLimit && !diagnostics.attempts) return reason;
      const fields = fingerprintFields.filter(field => diagnostics.changedFields.has(field));
      const summary = ` Review diagnostics: attempts=${diagnostics.attempts}; last requested ms=${diagnostics.lastRequestedMs ?? "none"};` +
        ` last elapsed ms=${diagnostics.lastElapsedMs ?? "none"}; late wake ms=${diagnostics.lastElapsedMs === null ? "none" : Math.max(0, diagnostics.lastElapsedMs - diagnostics.lastRequestedMs)};` +
        ` details became unavailable=${diagnostics.detailsBecameUnavailable ? "yes" : "no"}; changed fields=${fields.length ? fields.join(",") : "none (no fingerprint delta observed)"}.`;
      const bounded = summary.slice(0, 700);
      return `${reason.slice(0, 2000 - bounded.length)}${bounded}`;
    }
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
    function prepareDetails(run, record) {
      if (typeof adapter.prepareDetails !== "function") return;
      const previous = run.detailsPreparation;
      if (previous?.id === record.id && now() - previous.at < 1000) return;
      run.detailsPreparation = { id: record.id, at: now() };
      try { adapter.prepareDetails(record); } catch { /* Preparation cannot replace exact readiness checks. */ }
    }
    function matchingJob(run, record, previous) {
      if (!check(run)) return null;
      run.detailFailure = "The selected job card is missing, changed, or filtered.";
      if (!adapter.activeCard(record)) {
        run.detailFailure = adapter.detailFailure?.(record) || run.detailFailure;
        return null;
      }
      const job = adapter.scrape();
      const key = (value) => String(value || "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
      if (!job || job.jobIdSource === "query" || String(job.jobId) !== record.id ||
        key(job.company) !== key(record.company) || (typeof adapter.titleMatches === "function"
          ? adapter.titleMatches(job.title, record.title) !== true : key(job.title) !== key(record.title))) {
        run.detailFailure = adapter.detailFailure?.(record) || "The rendered details do not match the selected job's ID, title, and company.";
        return null;
      }
      if (!job.description?.trim()) {
        run.detailFailure = "The selected job's description is not readable yet.";
        prepareDetails(run, record);
        return null;
      }
      if (!descriptionIsCurrent(job, previous)) {
        run.detailFailure = "The selected job still shows the previous job's description; waiting for its own description to load.";
        prepareDetails(run, record);
        return null;
      }
      if (job.applicationsAvailable === false && !job.applicationsClosed) {
        run.detailFailure = "The selected job has no ready application control or verified external application link.";
        return null;
      }
      run.detailFailure = stabilityFailure;
      return job;
    }
    function readMatchingJob(run, record, previous, diagnostics) {
      try { const job = matchingJob(run, record, previous); observeDetails(diagnostics, job); return job; }
      catch (error) {
        if (!check(run)) return null;
        run.detailFailure = String(error?.message || "The selected job details could not be read.").slice(0, 1000);
        observeDetails(diagnostics, null);
        return null;
      }
    }
    async function details(run, record, previous, jobDeadline, diagnostics) {
      let stable = "", stableAt = 0, waitingReason = "";
      const deadline = Math.min(now() + 90_000, jobDeadline);
      // Each poll rechecks the exact selected job, even after a late wake.
      while (check(run) && now() < deadline) {
        if (!await pause(run, Math.min(500, deadline - now()))) return null;
        if (!check(run) || now() >= deadline) return null;
        const job = readMatchingJob(run, record, previous, diagnostics);
        if (!job) {
          stable = "";
          if (run.detailFailure !== waitingReason) {
            waitingReason = run.detailFailure;
            adapter.status(`Waiting for ${record.company} — ${waitingReason}`, run.state);
          }
          continue;
        }
        const value = fingerprint(job);
        if (value !== stable) { stable = value; stableAt = now(); continue; }
        if (now() - stableAt >= 500) return job;
      }
      return null;
    }
    async function notSaved(run, record, code, reason, job) {
      if (!active(run) || typeof adapter.notSaved !== "function") return;
      try { await adapter.notSaved(record, { code, reason, ...(job ? { job } : {}) }, run.state.id); }
      catch { /* Reporting must not stop collection or retry a capture. */ }
    }
    async function collect(run, record) {
      if (!await adapter.allowed(record) || !check(run) || !adapter.activeCard(record)) {
        run.state.counts.skipped++;
        await notSaved(run, record, "CARD_UNAVAILABLE", "The attempted job card is unavailable or was filtered before capture.");
        return;
      }
      if (!await pause(run, actionDelay())) return;
      try { await adapter.reveal(record); }
      catch (error) { await notSaved(run, record, "CARD_UNAVAILABLE", error.message); throw error; }
      if (!await pause(run, actionDelay())) return;
      if (!adapter.activeCard(record)) { await notSaved(run, record, "CARD_UNAVAILABLE", "The attempted job card became unavailable before selection."); return; }
      let previous;
      try { previous = adapter.scrape(); } catch { /* A previous unreadable panel cannot stop the new selection. */ }
      const jobDeadline = now() + 180_000;
      try { adapter.select(record); }
      catch (error) { await notSaved(run, record, "CARD_UNAVAILABLE", error.message); throw error; }
      let job, reviewedJob, recovered = false, ready = false, reviewLimitReached = false;
      const diagnostics = { attempts: 0, lastRequestedMs: null, lastElapsedMs: null, detailsBecameUnavailable: false,
        changedFields: new Set(), lastValues: null, lastReviewFailure: "" };
      while (check(run) && now() < jobDeadline) {
        job = await details(run, record, previous, jobDeadline, diagnostics);
        if (!job) {
          // Recovery is bounded and only happens before any capture attempt.
          if (check(run) && now() < jobDeadline && !recovered && typeof adapter.recoverDetails === "function") {
            recovered = true;
            adapter.status(`Reopening details for ${record.company}…`, run.state);
            try {
              const reopened = await adapter.recoverDetails(record);
              if (reopened !== false) continue;
            } catch (error) {
              run.state.counts.skipped++;
              await notSaved(run, record, "DETAILS_NOT_CONFIRMED", reviewFailureReason(`${run.detailFailure} Reopening failed: ${error.message}`,
                diagnostics, now() >= jobDeadline), reviewedJob);
              throw error;
            }
          }
          break;
        }
        reviewedJob = job;
        const reviewing = fingerprint(job);
        const delay = reviewDelay(job.description, random);
        if (now() + delay > jobDeadline) {
          run.detailFailure = "The selected details did not leave enough time for a complete review within the 180-second job limit.";
          reviewLimitReached = true;
          break;
        }
        adapter.status(`Reviewing ${job.company} — about ${Math.round(delay / 1000)} seconds.`, run.state);
        diagnostics.attempts++;
        diagnostics.lastRequestedMs = delay;
        const reviewStartedAt = now();
        if (!await pause(run, delay)) return;
        diagnostics.lastElapsedMs = Math.max(0, now() - reviewStartedAt);
        if (now() >= jobDeadline) break;
        job = readMatchingJob(run, record, previous, diagnostics);
        if (!job || fingerprint(job) !== reviewing) {
          diagnostics.lastReviewFailure = job ? "The selected job's fingerprint changed during review." : "The selected job's details became unavailable during review.";
          adapter.status(`Waiting for ${record.company} — the details changed during review.`, run.state);
          continue;
        }
        if (!await adapter.allowed(record) || !check(run)) {
          run.state.counts.skipped++;
          await notSaved(run, record, "CARD_UNAVAILABLE", "The attempted job card became unavailable or was filtered during review.", reviewedJob);
          return;
        }
        if (now() >= jobDeadline) break;
        job = readMatchingJob(run, record, previous, diagnostics);
        if (!job || fingerprint(job) !== reviewing) {
          diagnostics.lastReviewFailure = job ? "The selected job's fingerprint changed before capture." : "The selected job's details became unavailable before capture.";
          adapter.status(`Waiting for ${record.company} — the details changed before capture.`, run.state);
          continue;
        }
        ready = true;
        break;
      }
      if (!check(run)) return;
      if (!ready) {
        run.state.counts.skipped++;
        const limit = reviewLimitReached || now() >= jobDeadline ? " The 180-second verification and review limit was reached." : " The description did not become ready within the 90-second readiness window.";
        const failure = run.detailFailure === stabilityFailure && diagnostics.lastReviewFailure ? diagnostics.lastReviewFailure : run.detailFailure;
        const reason = (failure || "The selected job details could not be verified.") + limit;
        await notSaved(run, record, "DETAILS_NOT_CONFIRMED", reviewFailureReason(reason, diagnostics, reviewLimitReached || now() >= jobDeadline), reviewedJob);
        return;
      }
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
            loadingWait += 1250;
            if (loadingWait > 30_000) throw new Error("Results did not finish loading. Job collection stopped.");
            if (!await pause(run, 1250)) break;
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
  const api = Object.freeze({ create, searchKey, reviewDelay, descriptionIsCurrent });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LinkedInJobCollector = api;
})(typeof globalThis === "undefined" ? this : globalThis);
