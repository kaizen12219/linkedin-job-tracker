(function registerJobrightTracker() {
  "use strict";
  if (window.__JOBRIGHT_JOB_TRACKER_READY__) return;
  window.__JOBRIGHT_JOB_TRACKER_READY__ = true;
  const scraper = () => window.JobrightJobScraper;
  const key = (value) => String(value || "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  let classificationTimer, classificationVersion = 0, manualTimer, selection = null, selecting = false, scrapeFailure = "", selectedAuthorization = null;
  let collection = null, collectionId = "", startVersion = 0, waiting = null, notice, noticeTimer, lastScrollAt = 0;
  const captured = new Set();
  const records = () => scraper()?.cards(document) || [];
  const context = () => scraper()?.searchContext(document, window.location.href) || { filterKey: "", selectedRegion: "", selectedRegionSource: "" };
  const identity = (record) => JSON.stringify([record.id, key(record.company), key(record.title)]);
  const authorizationMatches = (record) => !!record && selectedAuthorization?.identity === identity(record);
  const hasCard = (record) => [...document.querySelectorAll(".job-card-flag-classname[id]")].some((card) => card.id === record.id);
  const currentRecord = (record) => {
    if (!record) return null;
    // React can replace the mounted card when its details open. Rebind only
    // the same unambiguous job identity, never a reused card or changed role.
    const matches = records().filter((item) => item.id === record.id);
    return matches.length === 1 && key(matches[0].company) === key(record.company) && key(matches[0].title) === key(record.title) ? matches[0] : null;
  };
  const unavailableBeforeSelection = () => Object.assign(new Error("The selected Jobright job card is no longer available with the same identity."),
    { code: "JOBRIGHT_PRESELECTION_UNAVAILABLE" });
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
  function authorizedMissingCard(record) {
    if (!record || hasCard(record) || !authorizationMatches(record) || selectedAuthorization.blocked || captured.has(identity(record))) return false;
    const currentContext = context();
    return !!selectedAuthorization.filterKey && currentContext.filterKey === selectedAuthorization.filterKey && currentContext.selectedRegion === "us" && currentContext.selectedRegionSource === "search-control";
  }
  const active = (record) => {
    if (!record || captured.has(identity(record)) || (authorizationMatches(record) && selectedAuthorization.blocked)) return false;
    const current = currentRecord(record);
    if (current) return !["banned", "duplicate"].includes(current.card.getAttribute("data-kai-flow-job-state")) && current.card.getAttribute("aria-disabled") !== "true";
    // A detail transition can unmount the selected card entirely. Only our
    // authorized selection may rely on exact rendered details in that case.
    // A present changed/malformed/duplicate card never gets this fallback.
    if (!authorizedMissingCard(record)) return false;
    const job = safeScrape();
    return !!matches(job, record) && job.searchContextKey === selectedAuthorization.filterKey && job.selectedRegion === "us" && job.selectedRegionSource === "search-control" &&
      (job.applicationsAvailable !== false || job.applicationsClosed === true);
  };
  function authorize(record, filterKey) {
    selectedAuthorization = { identity: identity(record), company: record.company, filterKey, blocked: false };
  }
  function selectRecord(record, filterKey = context().filterKey) {
    const current = currentRecord(record);
    const currentContext = context();
    if (!filterKey || currentContext.filterKey !== filterKey || currentContext.selectedRegion !== "us" || currentContext.selectedRegionSource !== "search-control") throw new Error("The search changed. Job collection stopped.");
    if (!current || !active(record) || !current.link.isConnected || scraper().jobId(current.link.href) !== record.id) throw unavailableBeforeSelection();
    selectedAuthorization = null;
    selecting = true;
    try { current.link.click(); authorize(current, filterKey); }
    finally { selecting = false; }
  }
  const matches = (job, record) => job && job.jobIdSource === "details" && job.jobId === record.id && key(job.company) === key(record.company) && key(job.title) === key(record.title) && job.description?.trim();
  function detailFailure(record) {
    if (captured.has(identity(record))) return "The selected Jobright job has already been captured in this page.";
    if (authorizationMatches(record) && selectedAuthorization.blocked) return "The selected Jobright company is banned or already recorded.";
    if (!currentRecord(record)) {
      if (hasCard(record)) return "The selected Jobright card is ambiguous or its company/title changed.";
      if (!authorizationMatches(record)) return "The selected Jobright card is missing and no exact selection was authorized.";
      const currentContext = context();
      if (currentContext.filterKey !== selectedAuthorization.filterKey || currentContext.selectedRegion !== "us") return "The selected Jobright search changed after the job was selected.";
    }
    const job = safeScrape();
    if (!job) {
      // Jobright rejects an unreadable body instead of returning partial
      // details, so its readiness error also prepares the authorized section.
      prepareDetails(record);
      return scrapeFailure;
    }
    if (!matches(job, record)) return "The rendered Jobright details do not match the selected job ID, company, and title.";
    if (job.applicationsAvailable === false && !job.applicationsClosed) return "The selected Jobright job has no available Apply control or verified external Original Job Post.";
    return "The selected Jobright details did not remain stable before capture.";
  }
  let detailsPrepared = null;
  function prepareDetails(record) {
    if (!authorizationMatches(record) || selectedAuthorization.blocked || captured.has(identity(record))) return;
    const currentContext = context();
    if (!selectedAuthorization.filterKey || currentContext.filterKey !== selectedAuthorization.filterKey || currentContext.selectedRegion !== "us" ||
      currentContext.selectedRegionSource !== "search-control" || (!currentRecord(record) && !authorizedMissingCard(record))) return;
    if (detailsPrepared?.id === record.id && Date.now() - detailsPrepared.at < 1000) return;
    const target = scraper()?.descriptionTarget?.(document, window.location.href, record);
    if (!target?.isConnected || target.closest(".job-card-flag-classname[id]") || typeof target.scrollIntoView !== "function") return;
    detailsPrepared = { id: record.id, at: Date.now() };
    target.scrollIntoView({ block: "center", behavior: "instant" });
  }
  function scheduleClassification(delay = 300) {
    clearTimeout(classificationTimer);
    classificationTimer = setTimeout(() => void classifyCards(), delay);
  }
  async function classifyCards() {
    const version = ++classificationVersion, cards = records();
    const companies = [...new Map([...cards.map((record) => [key(record.company), record.company]), ...(selectedAuthorization ? [[key(selectedAuthorization.company), selectedAuthorization.company]] : [])]).values()];
    if (!companies.length) return;
    let response;
    try { response = await chrome.runtime.sendMessage({ type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies, refresh: false }); } catch { return; }
    if (!response?.ok || version !== classificationVersion) return;
    const states = new Map((response.result?.companies || []).map((item) => [key(item.company), item]));
    if (selectedAuthorization) {
      const selectedState = states.get(key(selectedAuthorization.company));
      if (selectedState?.banned || selectedState?.duplicate) selectedAuthorization.blocked = selectedState.banned ? "banned" : "duplicate";
    }
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
    const state = currentRecord(record)?.card.getAttribute("data-kai-flow-job-state") || (authorizationMatches(record) && selectedAuthorization.blocked);
    if (captured.has(identity(record))) code = "ALREADY_CAPTURED";
    else if (state === "banned") code = "BANNED_COMPANY";
    else if (state === "duplicate") code = "DUPLICATE_COMPANY";
    if (!["BANNED_COMPANY", "DUPLICATE_COMPANY", "ALREADY_CAPTURED", "DETAILS_NOT_CONFIRMED", "CARD_UNAVAILABLE"].includes(code)) return;
    const reasonDetail = (code === "ALREADY_CAPTURED" ? "Skipped: this job was already submitted from this page."
      : typeof reason === "string" && reason.trim() ? reason.trim() : code === "DETAILS_NOT_CONFIRMED" ? detailFailure(record) : "").slice(0, 2000);
    let trackerVersion = "";
    try { trackerVersion = String(chrome.runtime.getManifest?.()?.version || "").slice(0, 64); } catch { /* Diagnostic metadata is optional. */ }
    let descriptionDiagnostics = "";
    if (code === "DETAILS_NOT_CONFIRMED") {
      try { descriptionDiagnostics = JSON.stringify(scraper()?.descriptionDiagnostics?.(document, window.location.href) || "").slice(0, 6000); } catch { /* Diagnostics cannot interrupt collection. */ }
    }
    const snapshot = { jobId: record.id, title: record.title, company: record.company, sourceUrl: `https://jobright.ai/jobs/info/${record.id}`,
      ...(reasonDetail ? { verificationReason: reasonDetail } : {}), ...(trackerVersion ? { trackerVersion } : {}),
      ...(descriptionDiagnostics ? { descriptionDiagnostics } : {}),
      detailAvailability: matches(job, record) ? "verified" : "unavailable" };
    if (matches(job, record)) for (const name of ["description", "workplaceType", "isEasyApply", "applicationsAvailable", "applicationsClosed", "selectedRegion", "selectedRegionSource", "searchContextKey"]) {
      if (job[name] !== undefined) snapshot[name] = job[name];
    }
    if (code === "DETAILS_NOT_CONFIRMED" && reasonDetail) status(`${record.company} — ${reasonDetail}`);
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
    const currentContext = context();
    if (currentContext.selectedRegion !== "us" || currentContext.selectedRegionSource !== "search-control" || !selection.filterKey) { selection = null; return; }
    authorize(record, selection.filterKey);
    scheduleManual(0);
  }
  function scheduleManual(delay) { clearTimeout(manualTimer); manualTimer = setTimeout(() => void captureManual(), delay); }
  async function captureManual() {
    const pending = selection;
    if (!pending || document.hidden) return;
    if (Date.now() > pending.until || context().filterKey !== pending.filterKey || !authorizationMatches(pending.record) || (!active(pending.record) && !authorizedMissingCard(pending.record))) {
      selection = null; void notSaved(pending.record, { code: "DETAILS_NOT_CONFIRMED" }); return;
    }
    const job = safeScrape();
    if (!matches(job, pending.record) || (pending.previousId !== job.jobId && pending.previousDescription && job.description === pending.previousDescription)) { prepareDetails(pending.record); scheduleManual(200); return; }
    if (job.applicationsAvailable === false && !job.applicationsClosed) { scheduleManual(200); return; }
    const value = JSON.stringify([job.jobId, job.company, job.title, job.description, job.applyUrl, job.workplaceType, job.applicationsClosed, job.searchContextKey]);
    if (value !== pending.stable) { pending.stable = value; pending.stableAt = Date.now(); scheduleManual(200); return; }
    if (Date.now() - pending.stableAt < 500) { scheduleManual(200); return; }
    if (selection !== pending || !active(pending.record)) return;
    selection = null; captured.add(identity(pending.record));
    try { await chrome.runtime.sendMessage({ type: "KAI_TRACKER_CAPTURE", job }); } catch { /* Do not retry an uncertain write automatically. */ }
  }
  function status(text, state, finished = false) {
    clearTimeout(noticeTimer); notice?.remove();
    notice = document.createElement("div"); notice.dataset.jobTrackerCollection = "true"; notice.setAttribute("role", finished && !text.startsWith("Finished") ? "alert" : "status"); notice.textContent = text;
    Object.assign(notice.style, { position: "fixed", bottom: "18px", right: "18px", zIndex: "2147483647", maxWidth: "360px", padding: "12px 14px", borderRadius: "8px", background: "#193044", color: "white", font: "13px/1.5 Arial,sans-serif", pointerEvents: "none" });
    document.documentElement.append(notice); noticeTimer = setTimeout(() => { notice?.remove(); notice = null; }, 5000);
  }
  function stop(text = "Job collection stopped.") {
    startVersion++; selectedAuthorization = null; collection?.stop(text);
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
    const initialContext = context();
    if (!frozen || window.LinkedInJobCollector.searchKey(window.location.href) !== state.searchKey ||
      (initialContext.filterKey && (initialContext.filterKey !== frozen || initialContext.selectedRegion !== "us" || initialContext.selectedRegionSource !== "search-control")))
      throw new Error("The search changed. Job collection stopped.");
    async function returnToResults({ recover = false } = {}) {
      const detailSourceUrl = scraper().jobId(window.location.href) ? window.location.href : "";
      const visibleControl = (node, opacityBackdrop = null) => {
        if (!node?.isConnected || node.matches(":disabled") || node.closest("[hidden], [aria-hidden='true'], [aria-disabled='true'], template, [inert]")) return false;
        for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
          const style = window.getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || (style.opacity === "0" && current !== opacityBackdrop)) return false;
        }
        return true;
      };
      const leavingLists = () => [...document.querySelectorAll("#jobs-page-main-content [class*='index_jobs-list__'][class*='index_jobs-list-leave__']")];
      const returnContext = () => {
        const current = context();
        if (current.filterKey || !detailSourceUrl || leavingLists().length !== 1) return current;
        // Closing the route may precede its background-tab animation. These
        // same committed controls were already readable under this exact
        // detail backdrop; read them only to guard a results-link fallback.
        return scraper().searchContext(document, detailSourceUrl);
      };
      const guardReturn = () => {
        if (version !== startVersion) throw new Error("Job collection stopped.");
        const current = returnContext();
        if (window.LinkedInJobCollector.searchKey(window.location.href) !== state.searchKey ||
          (current.filterKey && (current.filterKey !== frozen || current.selectedRegion !== "us" || current.selectedRegionSource !== "search-control")))
          throw new Error("The search changed. Job collection stopped.");
        return current;
      };
      const resultsLink = () => [...document.querySelectorAll("a[href]")].find((anchor) => {
        if (!visibleControl(anchor)) return false;
        try {
          const url = new URL(anchor.href, window.location.href);
          if (url.origin !== window.location.origin || !/^\/jobs\/recommend\/?$/u.test(url.pathname) || window.LinkedInJobCollector.searchKey(url.href) !== state.searchKey) return false;
          return true;
        } catch { return false; }
      });
      const filterSignature = (control) => JSON.stringify([
        control.getAttribute("data-preference-key"), control.getAttribute("data-preference-measure"),
        String(control.textContent || "").replace(/\s+/gu, " ").trim(),
        [...control.querySelectorAll("[title]")].map((node) => node.getAttribute("title"))
      ]);
      const observedControls = (opacityBackdrop = null) => [...document.querySelectorAll("[data-preference-key]")].filter((control) =>
        visibleControl(control, opacityBackdrop) && !control.closest("[role='dialog'], [role='listbox'], [role='menu'], [aria-modal='true'], [popover], .ant-popover, .ant-dropdown, .ant-modal, [data-slot='popover-content'], [data-radix-popper-content-wrapper]"));
      let ownCloseProof = null;
      const verifyObservedControls = () => {
        if (!ownCloseProof) return;
        for (const [control, signature] of ownCloseProof.controls) {
          if (control.isConnected && filterSignature(control) !== signature) throw new Error("The search changed. Job collection stopped.");
        }
        // A new visible partial topbar must not silently replace a changed
        // committed filter while the country control is still unmounted.
        for (const control of observedControls()) {
          const key = control.getAttribute("data-preference-key");
          const prior = ownCloseProof.filters.get(key);
          if (!prior || !prior.has(filterSignature(control))) throw new Error("The search changed. Job collection stopped.");
        }
      };
      const preservedResultsLink = () => {
        if (!ownCloseProof?.filters.has("country") || scraper().jobId(window.location.href)) return null;
        let current;
        try { current = new URL(window.location.href); } catch { return null; }
        if (current.origin !== window.location.origin || !/^\/jobs\/recommend\/?$/u.test(current.pathname) ||
          window.LinkedInJobCollector.searchKey(current.href) !== state.searchKey) return null;
        const { anchor, href, ownerDocument } = ownCloseProof;
        return anchor?.ownerDocument === ownerDocument && ownerDocument === document && visibleControl(anchor) && anchor.href === href ? anchor : null;
      };
      // Only close the job details. Apply, Like, Hide and Orion keep their
      // native behavior. Navigation may use an observed link to these exact
      // results if the detail's close control never finished rendering.
      const startedAt = Date.now(), deadline = startedAt + 90_000;
      let usedResultsLink = false, closeAttempted = false, announced = false, closeAttemptedAt = startedAt;
      while (Date.now() < deadline) {
        const current = guardReturn();
        verifyObservedControls();
        if (!scraper().jobId(window.location.href) && !leavingLists().length && searchKey() === state.searchKey) return true;
        if (!announced) { status("Returning to Jobright results…", state); announced = true; }
        const committed = current.filterKey === frozen && current.selectedRegion === "us" && current.selectedRegionSource === "search-control";
        if (committed && !closeAttempted && scraper().jobId(window.location.href)) {
          const closes = [...document.querySelectorAll("button[id*='job-detail-close-button']")].filter(visibleControl);
          const close = closes.length === 1 ? closes[0] : null;
          const control = close || resultsLink();
          if (!control) {
            if (recover) return false;
            throw new Error(closes.length > 1 ? "The Jobright detail close controls are ambiguous. Job collection stopped."
              : "The Jobright detail view could not be closed. Job collection stopped.");
          }
          guardReturn();
          if (close) {
            const anchor = resultsLink();
            // The frozen context was just verified by the scraper. Mirror its
            // one exact detail-backdrop opacity exception for snapshots only;
            // controls never become clickable or capture-ready through it.
            const lists = leavingLists(), backdrop = detailSourceUrl && lists.length === 1 ? lists[0] : null;
            const controls = observedControls(backdrop).map((node) => [node, filterSignature(node)]);
            const filters = new Map();
            for (const [node, signature] of controls) {
              const key = node.getAttribute("data-preference-key"), values = filters.get(key) || new Set();
              values.add(signature); filters.set(key, values);
            }
            ownCloseProof = { anchor, href: anchor?.href || "", ownerDocument: document, controls, filters };
          }
          closeAttempted = true; usedResultsLink = !close; closeAttemptedAt = Date.now();
          control.click();
          continue;
        }
        if (!usedResultsLink && Date.now() - closeAttemptedAt >= 5000 && (committed || ownCloseProof)) {
          const fallback = committed ? resultsLink() : preservedResultsLink();
          if (fallback) {
            guardReturn();
            verifyObservedControls();
            usedResultsLink = true;
            status("Waiting for Jobright results — reopening the verified results link…", state);
            fallback.click();
          }
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        if (!await wait(Math.min(200, remaining), state.id)) throw new Error("Job collection stopped.");
      }
      guardReturn();
      verifyObservedControls();
      const current = returnContext();
      throw new Error("The Jobright results did not return within 90 seconds after closing details. Job collection stopped." +
        ` Detail route: ${!!scraper().jobId(window.location.href)}; collapsed list: ${!!leavingLists().length}; committed filters: ${current.filterKey === frozen && current.selectedRegion === "us"}; results link used: ${usedResultsLink}; preclose link observed: ${!!ownCloseProof?.anchor}; preclose filter proof intact: ${!!ownCloseProof?.filters.has("country")}.`);
    }
    waiting = { ...state, localVersion: version };
    let release = () => {}, started = false, leaseAcquired = false;
    try {
      release = await lease(state.id);
      leaseAcquired = true;
      await returnToResults();
      for (let elapsed = 0; !records().length && elapsed < 15_000; elapsed += 200) {
        if (!await wait(200, state.id) || version !== startVersion) return;
        if (searchKey() !== state.searchKey) throw new Error("The search changed. Job collection stopped.");
      }
      if (version !== startVersion) return;
      if (!records().length) throw new Error("Results did not finish loading. Job collection stopped.");
      selection = null; selectedAuthorization = null; clearTimeout(manualTimer); collectionId = state.id; lastScrollAt = 0;
      collection = window.LinkedInJobCollector.create({
        searchKey, wait, cards: records, activeCard: active, scrape: safeScrape, detailFailure, notSaved, prepareDetails,
        async allowed(record) {
          if (!active(record)) return false;
          const check = await message({ type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies: [record.company], refresh: false });
          if (!check?.ok) throw new Error(check?.error?.message || "Company checks are unavailable. Job collection stopped.");
          const match = check.result?.companies?.find((item) => key(item.company) === key(record.company));
          if (!match) throw new Error("Company checks are incomplete. Job collection stopped.");
          if (match.banned || match.duplicate) {
            const blocked = match.banned ? "banned" : "duplicate";
            if (authorizationMatches(record)) selectedAuthorization.blocked = blocked;
            currentRecord(record)?.card.setAttribute("data-kai-flow-job-state", blocked);
            return false;
          }
          return active(record);
        },
        async top() { await returnToResults(); const target = scroller(); if (!target) throw new Error("The Jobright results list is unavailable."); target.scrollTo({ top: 0, behavior: "instant" }); },
        async reveal(record) {
          await returnToResults();
          const current = currentRecord(record);
          if (!current) throw unavailableBeforeSelection();
          current.card.scrollIntoView({ block: "center", behavior: "instant" });
        },
        select(record) { selectRecord(record, frozen); },
        async recoverDetails(record) {
          if (!authorizationMatches(record) || selectedAuthorization.blocked || captured.has(identity(record))) return false;
          if (!await returnToResults({ recover: true })) return false;
          if (searchKey() !== state.searchKey) throw new Error("The search changed. Job collection stopped.");
          const current = currentRecord(record);
          if (!current || !active(current)) return false;
          current.card.scrollIntoView({ block: "center", behavior: "instant" });
          selectRecord(current, frozen);
          return true;
        },
        async capture(job, runId) {
          if (job.searchContextKey !== frozen) throw new Error("The search changed. Job collection stopped.");
          const result = await message({ type: "KAI_TRACKER_CAPTURE", job, runId });
          if (result?.ok) captured.add(identity({ id: job.jobId, company: job.company, title: job.title }));
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
        async confirmEnd() {
          await returnToResults();
          const target = scroller();
          if (!target) throw new Error("The Jobright results list is unavailable.");
          const snapshot = () => JSON.stringify([records().map(record => record.id), target.scrollTop, target.clientHeight, target.scrollHeight]);
          const atBottom = () => target.scrollTop + target.clientHeight >= target.scrollHeight - 4;
          const guard = () => {
            if (version !== startVersion) throw new Error("Job collection stopped.");
            if (searchKey() !== state.searchKey) throw new Error("The search changed. Job collection stopped.");
          };
          const startedAt = Date.now(), initial = snapshot();
          let quietSince = startedAt, lastProbeAt = -Infinity, lastObservedAt = startedAt, probes = 0;
          // Reaching the current bottom is only a request for the next batch.
          // Observe a quiet list after repeated probes, including short lists
          // where the first scroll cannot move the viewport at all.
          while (Date.now() - startedAt < 60_000) {
            guard();
            if (scroller() !== target || !target.isConnected || snapshot() !== initial || !atBottom()) return false;
            const now = Date.now();
            const readable = target.clientHeight > 0 && target.scrollHeight >= target.clientHeight;
            if (!readable || loading() || now - lastObservedAt > 5000) quietSince = now;
            lastObservedAt = now;
            if (now - lastProbeAt >= 5000) {
              status("Checking for more Jobright jobs — waiting for the results list to settle…", state);
              target.scrollTo({ top: Math.max(0, target.scrollHeight - target.clientHeight), behavior: "instant" });
              lastProbeAt = now; probes++;
              guard();
              if (scroller() !== target || !target.isConnected || snapshot() !== initial || !atBottom()) return false;
              if (loading()) quietSince = Date.now();
            }
            if (readable && !loading() && probes >= 3 && Date.now() - quietSince >= 30_000) return true;
            const remaining = 60_000 - (Date.now() - startedAt);
            if (remaining <= 0) break;
            if (!await wait(Math.min(1000, remaining), state.id)) throw new Error("Job collection stopped.");
          }
          guard();
          throw new Error("More Jobright results may still be loading. The end of the list could not be confirmed within 60 seconds. Job collection stopped.");
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
