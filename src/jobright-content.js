(function registerJobrightTracker() {
  "use strict";
  if (window.__JOBRIGHT_JOB_TRACKER_READY__) return;
  window.__JOBRIGHT_JOB_TRACKER_READY__ = true;
  const scraper = () => window.JobrightJobScraper;
  const key = (value) => String(value || "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  let classificationTimer, classificationVersion = 0, manualTimer, selection = null, selecting = false, scrapeFailure = "";
  let collection = null, collectionId = "", startVersion = 0, waiting = null, notice, noticeTimer, lastScrollAt = 0;
  const captured = new Set();
  const records = () => scraper()?.cards(document) || [];
  const context = () => scraper()?.searchContext(document, window.location.href) || { filterKey: "", selectedRegion: "", selectedRegionSource: "" };
  const currentRecord = (record) => {
    if (!record) return null;
    // React can replace the mounted card when its details open. Rebind only
    // the same unambiguous job identity, never a reused card or changed role.
    const matches = records().filter((item) => item.id === record.id && key(item.company) === key(record.company) && key(item.title) === key(record.title));
    return matches.length === 1 ? matches[0] : null;
  };
  const safeScrape = () => {
    try {
      const job = scraper()?.scrape(document, window.location.href) || null;
      scrapeFailure = job ? "" : "The Jobright scraper is not available.";
      return job;
    } catch (error) {
      scrapeFailure = String(error?.message || "The selected Jobright details could not be read.").slice(0, 1000);
      return null;
    }
  };
  const active = (record) => {
    const current = currentRecord(record);
    return !!current && !captured.has(current.identity) && !["banned", "duplicate"].includes(current.card.getAttribute("data-kai-flow-job-state")) &&
      current.card.getAttribute("aria-disabled") !== "true";
  };
  function selectRecord(record) {
    const current = currentRecord(record);
    if (!current || !active(record) || !current.link.isConnected || scraper().jobId(current.link.href) !== record.id) throw new Error("The selected job card changed.");
    selecting = true;
    try { current.link.click(); }
    finally { selecting = false; }
  }
  const matches = (job, record) => job && job.jobIdSource === "details" && job.jobId === record.id && key(job.company) === key(record.company) && key(job.title) === key(record.title) && job.description?.trim();
  function detailFailure(record) {
    if (!currentRecord(record)) return "The selected Jobright card is missing, ambiguous, or its company/title changed.";
    const job = safeScrape();
    if (!job) return scrapeFailure;
    if (!matches(job, record)) return "The rendered Jobright details do not match the selected job ID, company, and title.";
    if (job.applicationsAvailable === false && !job.applicationsClosed) return "The selected Jobright job has no available Apply control or verified external Original Job Post.";
    return "The selected Jobright details did not remain stable before capture.";
  }
  function scheduleClassification(delay = 300) {
    clearTimeout(classificationTimer);
    classificationTimer = setTimeout(() => void classifyCards(), delay);
  }
  async function classifyCards() {
    const version = ++classificationVersion, cards = records();
    const companies = [...new Map(cards.map((record) => [key(record.company), record.company])).values()];
    if (!companies.length) return;
    let response;
    try { response = await chrome.runtime.sendMessage({ type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies, refresh: false }); } catch { return; }
    if (!response?.ok || version !== classificationVersion) return;
    const states = new Map((response.result?.companies || []).map((item) => [key(item.company), item]));
    for (const record of cards) {
      const current = currentRecord(record);
      if (!current) continue;
      const match = states.get(key(record.company));
      if (match?.banned || match?.duplicate) current.card.setAttribute("data-kai-flow-job-state", match.banned ? "banned" : "duplicate");
      else current.card.removeAttribute("data-kai-flow-job-state");
    }
  }
  async function message(value) {
    let timer;
    try { return await Promise.race([chrome.runtime.sendMessage(value), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The tracker did not respond. Job collection stopped.")), 40_000);
    })]); } finally { clearTimeout(timer); }
  }
  async function notSaved(record, { code, job, reason } = {}, runId) {
    if (!/^[a-f0-9]{24}$/u.test(record?.id || "") || !record.company || !record.title) return;
    const state = currentRecord(record)?.card.getAttribute("data-kai-flow-job-state");
    if (state === "banned") code = "BANNED_COMPANY";
    else if (state === "duplicate") code = "DUPLICATE_COMPANY";
    if (!["BANNED_COMPANY", "DUPLICATE_COMPANY", "DETAILS_NOT_CONFIRMED", "CARD_UNAVAILABLE"].includes(code)) return;
    const snapshot = { jobId: record.id, title: record.title, company: record.company, sourceUrl: `https://jobright.ai/jobs/info/${record.id}`,
      detailAvailability: matches(job, record) ? "verified" : "unavailable" };
    if (matches(job, record)) for (const name of ["description", "workplaceType", "isEasyApply", "applicationsAvailable", "applicationsClosed", "selectedRegion", "selectedRegionSource", "searchContextKey"]) {
      if (job[name] !== undefined) snapshot[name] = job[name];
    }
    const reasonDetail = typeof reason === "string" ? reason.trim().slice(0, 2000) : "";
    try { await chrome.runtime.sendMessage({ type: "KAI_TRACKER_NOT_SAVED", job: snapshot, reasonCode: code, ...(reasonDetail ? { reasonDetail } : {}), ...(runId ? { runId } : {}) }); } catch { /* A report must not block native navigation. */ }
  }
  function onClick(event) {
    if (selecting || event.isTrusted !== true || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const card = target?.closest(".job-card-flag-classname[id]");
    if (!card || target.closest("button, input, select, [role='button']")) return;
    const record = records().find((item) => item.card === card);
    // Only the primary title link selects a job. Match scores, Apply and Orion
    // controls retain their own behavior and never authorize a capture.
    if (!record || !record.link.contains(target) || !active(record)) return;
    if (collection?.running() || waiting) stop("Stopped — you selected a job.");
    const previous = safeScrape();
    selection = { record, previousId: previous?.jobId, previousDescription: previous?.description,
      filterKey: context().filterKey, until: Date.now() + 15_000, stable: "", stableAt: 0 };
    scheduleManual(0);
  }
  function scheduleManual(delay) { clearTimeout(manualTimer); manualTimer = setTimeout(() => void captureManual(), delay); }
  async function captureManual() {
    const pending = selection;
    if (!pending || document.hidden) return;
    if (Date.now() > pending.until || context().filterKey !== pending.filterKey || !active(pending.record)) {
      selection = null; void notSaved(pending.record, { code: "DETAILS_NOT_CONFIRMED" }); return;
    }
    const job = safeScrape();
    if (!matches(job, pending.record) || (pending.previousId !== job.jobId && pending.previousDescription && job.description === pending.previousDescription)) { scheduleManual(200); return; }
    if (job.applicationsAvailable === false && !job.applicationsClosed) { scheduleManual(200); return; }
    const value = JSON.stringify([job.jobId, job.company, job.title, job.description, job.applyUrl, job.workplaceType, job.applicationsClosed, job.searchContextKey]);
    if (value !== pending.stable) { pending.stable = value; pending.stableAt = Date.now(); scheduleManual(200); return; }
    if (Date.now() - pending.stableAt < 500) { scheduleManual(200); return; }
    if (selection !== pending || !active(pending.record)) return;
    selection = null; captured.add(pending.record.identity);
    try { await chrome.runtime.sendMessage({ type: "KAI_TRACKER_CAPTURE", job }); } catch { /* Do not retry an uncertain write automatically. */ }
  }
  function status(text, state, finished = false) {
    clearTimeout(noticeTimer); notice?.remove();
    notice = document.createElement("div"); notice.dataset.jobTrackerCollection = "true"; notice.setAttribute("role", finished && !text.startsWith("Finished") ? "alert" : "status"); notice.textContent = text;
    Object.assign(notice.style, { position: "fixed", bottom: "18px", right: "18px", zIndex: "2147483647", maxWidth: "360px", padding: "12px 14px", borderRadius: "8px", background: "#193044", color: "white", font: "13px/1.5 Arial,sans-serif", pointerEvents: "none" });
    document.documentElement.append(notice); noticeTimer = setTimeout(() => { notice?.remove(); notice = null; }, 5000);
  }
  function stop(text = "Job collection stopped.") {
    startVersion++; collection?.stop(text);
    const pending = waiting; waiting = null;
    if (pending) { status(text, pending, true); void message({ type: "KAI_TRACKER_RUN_END", runId: pending.id }).catch(() => {}); }
  }
  async function wait(milliseconds, runId) {
    const response = await message({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds });
    if (!response?.ok) throw new Error(response?.error?.message || "Collection timing is unavailable. Job collection stopped.");
    return response.result?.stopped !== true;
  }
  function lease(runId) {
    if (!window.navigator?.locks?.request) throw new Error("This browser cannot run background collection. Update your browser.");
    if (typeof runId !== "string" || !runId || runId.length > 128) throw new Error("The collection identity is invalid. Restart job collection.");
    // Reloaded documents share a run lock; independent runs keep collecting.
    return new Promise((resolve, reject) => window.navigator.locks.request(`job-tracker-collection:${runId}`, { ifAvailable: true }, (lock) => {
      if (!lock) { reject(new Error("Another collection is still stopping. Try again shortly.")); return; }
      return new Promise((release) => resolve(release));
    }).catch(reject));
  }
  const scroller = () => document.querySelector("#jobs-page-main-content");
  const loading = () => {
    const scope = scroller();
    if (scope?.getAttribute("aria-busy") === "true") return true;
    // Match percentages and company charts also use progressbar roles.
    return [...(scope?.querySelectorAll("[role='progressbar']:not([aria-valuenow]), [aria-busy='true']") || [])].some((node) => {
      if (node.closest("[class*='index_jobDetailContent__'], [hidden], [aria-hidden='true']")) return false;
      for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    });
  };
  async function resume(expectedId) {
    if (!window.LinkedInJobCollector || !scraper()) { if (expectedId) throw new Error("Reload the extension and Jobright tab to load job collection."); return; }
    const version = ++startVersion, response = await message({ type: "KAI_TRACKER_RUN_STATE" });
    if (!response?.ok) throw new Error(response?.error?.message || "The collection state could not be read.");
    const state = response.result?.state;
    if (version !== startVersion || !state || (expectedId && state.id !== expectedId)) return;
    if (collection?.running()) { if (collectionId === state.id) return; await collection.completion(); if (version === startVersion) return resume(expectedId); return; }
    const frozen = state.filterKey || "";
    const searchKey = () => {
      const current = context();
      return current.filterKey === frozen && current.selectedRegion === "us" ? window.LinkedInJobCollector.searchKey(window.location.href) : "";
    };
    if (!frozen || searchKey() !== state.searchKey) throw new Error("The search changed. Job collection stopped.");
    async function returnToResults({ recover = false } = {}) {
      if (!scraper().jobId(window.location.href)) return true;
      const close = document.querySelector("button[id*='job-detail-close-button']");
      let control = close && !close.disabled && close.getAttribute("aria-disabled") !== "true" ? close : null;
      if (!control) {
        control = [...document.querySelectorAll("a[href]")].find((anchor) => {
          try {
            const url = new URL(anchor.href, window.location.href);
            if (url.origin !== window.location.origin || !/^\/jobs\/recommend\/?$/u.test(url.pathname) || window.LinkedInJobCollector.searchKey(url.href) !== state.searchKey) return false;
            if (anchor.closest("[hidden], [aria-hidden='true'], [aria-disabled='true'], template, [inert]")) return false;
            for (let current = anchor; current && current.nodeType === 1; current = current.parentElement) {
              const style = window.getComputedStyle(current);
              if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
            }
            return true;
          } catch { return false; }
        });
      }
      if (!control) {
        if (recover) return false;
        throw new Error("The Jobright detail view could not be closed. Job collection stopped.");
      }
      // Only close the job details. Apply, Like, Hide and Orion keep their
      // native behavior. Navigation may use an observed link to these exact
      // results if the detail's close control never finished rendering.
      control.click();
      for (let elapsed = 0; elapsed < 15_000; elapsed += 200) {
        if (version !== startVersion) throw new Error("Job collection stopped.");
        const current = context();
        if (window.LinkedInJobCollector.searchKey(window.location.href) !== state.searchKey ||
          (current.filterKey && (current.filterKey !== frozen || current.selectedRegion !== "us"))) throw new Error("The search changed. Job collection stopped.");
        const collapsed = document.querySelector("#jobs-page-main-content [class*='index_jobs-list__'][class*='index_jobs-list-leave__']");
        if (!scraper().jobId(window.location.href) && !collapsed && searchKey() === state.searchKey) return true;
        if (!await wait(200, state.id)) throw new Error("Job collection stopped.");
      }
      throw new Error("The Jobright results did not return after closing details. Job collection stopped.");
    }
    waiting = { ...state, localVersion: version };
    let release = () => {}, started = false, leaseAcquired = false;
    try {
      release = await lease(state.id);
      leaseAcquired = true;
      for (let elapsed = 0; !records().length && elapsed < 15_000; elapsed += 200) {
        if (!await wait(200, state.id) || version !== startVersion) return;
        if (searchKey() !== state.searchKey) throw new Error("The search changed. Job collection stopped.");
      }
      if (version !== startVersion) return;
      if (!records().length) throw new Error("Results did not finish loading. Job collection stopped.");
      selection = null; clearTimeout(manualTimer); collectionId = state.id; lastScrollAt = 0;
      collection = window.LinkedInJobCollector.create({
        searchKey, wait, cards: records, activeCard: active, scrape: safeScrape, detailFailure, notSaved,
        async allowed(record) {
          if (!active(record)) return false;
          const check = await message({ type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies: [record.company], refresh: false });
          if (!check?.ok) throw new Error(check?.error?.message || "Company checks are unavailable. Job collection stopped.");
          const match = check.result?.companies?.find((item) => key(item.company) === key(record.company));
          if (!match) throw new Error("Company checks are incomplete. Job collection stopped.");
          if (match.banned || match.duplicate) { currentRecord(record)?.card.setAttribute("data-kai-flow-job-state", match.banned ? "banned" : "duplicate"); return false; }
          return active(record);
        },
        async top() { await returnToResults(); const target = scroller(); if (!target) throw new Error("The Jobright results list is unavailable."); target.scrollTo({ top: 0, behavior: "instant" }); },
        async reveal(record) {
          await returnToResults();
          const current = currentRecord(record);
          if (!current) throw new Error("The selected job card changed.");
          current.card.scrollIntoView({ block: "center", behavior: "instant" });
        },
        select: selectRecord,
        async recoverDetails(record) {
          if (!await returnToResults({ recover: true })) return false;
          if (searchKey() !== state.searchKey) throw new Error("The search changed. Job collection stopped.");
          const current = currentRecord(record);
          if (!current || !active(current)) return false;
          current.card.scrollIntoView({ block: "center", behavior: "instant" });
          selectRecord(current);
          return true;
        },
        async capture(job, runId) {
          if (job.searchContextKey !== frozen) throw new Error("The search changed. Job collection stopped.");
          const result = await message({ type: "KAI_TRACKER_CAPTURE", job, runId });
          if (result?.ok) { const record = records().find((item) => item.id === job.jobId); if (record) captured.add(record.identity); }
          return result;
        },
        async more() {
          await returnToResults();
          if (loading()) return "loading";
          const target = scroller(); if (!target) throw new Error("The Jobright results list is unavailable.");
          if (target.scrollTop + target.clientHeight < target.scrollHeight - 4) {
            target.scrollTo({ top: Math.min(target.scrollHeight - target.clientHeight, target.scrollTop + Math.max(100, target.clientHeight * .8)), behavior: "instant" });
            lastScrollAt = Date.now(); return "scrolled";
          }
          return lastScrollAt && Date.now() - lastScrollAt < 2500 ? "loading" : "bottom";
        },
        loading, pageKey: () => records().map((record) => record.id).join(","), next: () => null,
        async revealNext() {}, async goNext() {}, status,
        async checkpoint(next) {
          const result = await message({ type: "KAI_TRACKER_RUN_CHECKPOINT", runId: next.id, state: next });
          if (!result?.ok) throw new Error(result?.error?.message || "Collection progress could not be saved.");
          if (result.result?.stopped) collection.stop();
        },
        async finished(runId) { await message({ type: "KAI_TRACKER_RUN_END", runId }); }
      });
      collection.start(state); started = true;
      void collection.completion().then(release, release);
    } catch (error) {
      if (leaseAcquired) await message({ type: "KAI_TRACKER_RUN_END", runId: state.id }); status(error.message, state, true); throw error;
    } finally { if (waiting?.localVersion === version) waiting = null; if (!started) release(); }
  }
  chrome.runtime.onMessage.addListener((request, _sender, respond) => {
    if (request?.type === "KAI_TRACKER_RUN_STOP") { stop(); respond({ ok: true }); return false; }
    if (request?.type === "KAI_TRACKER_RUN_START") { void resume(request.state?.id).then(() => respond({ ok: true }), (error) => respond({ ok: false, error: error.message })); return true; }
    if (request?.type === "KAI_TRACKER_SEARCH_CONTEXT") { respond({ ok: true, result: context() }); return false; }
    if (request?.type === "KAI_TRACKER_REFRESH_STYLES") { scheduleClassification(0); respond({ ok: true }); return false; }
    if (request?.type !== "SCRAPE_LINKEDIN_JOB") return undefined;
    try { respond({ ok: true, data: scraper().scrape(document, window.location.href) }); } catch (error) { respond({ ok: false, error: error.message }); }
    return false;
  });
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", (event) => {
    if (event.isTrusted && (collection?.running() || waiting) && event.target?.closest?.("button,a,input,select,[role='button']") && !event.target.closest("[data-job-tracker-collection]")) stop("Stopped — you took control of the page.");
  }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") stop(); });
  document.addEventListener("visibilitychange", () => { scheduleClassification(0); if (selection) scheduleManual(0); });
  new MutationObserver(() => { scheduleClassification(); if (selection) scheduleManual(0); }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("scroll", () => scheduleClassification(), { capture: true, passive: true });
  scheduleClassification(250); setInterval(() => scheduleClassification(0), 30_000);
  if (window.LinkedInJobCollector) void resume().catch(() => {});
})();
