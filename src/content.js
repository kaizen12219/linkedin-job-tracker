(function registerLinkedInJobScraperContentScript() {
  if (window.__LINKEDIN_JOB_SCRAPER_CONTENT_READY__) return;
  window.__LINKEDIN_JOB_SCRAPER_CONTENT_READY__ = true;

  const CARD_SELECTOR = [
    "li[data-occludable-job-id]",
    "li.jobs-search-results__list-item",
    ".job-card-container[data-job-id]",
    "[data-view-name='job-card']",
    "[data-job-id].job-card-container",
    // LinkedIn's current search UI uses generated class names. The component
    // marker and button semantics survive those class-name rotations.
    "[role='button'][componentkey^='job-card-component-ref-']"
  ].join(",");
  const COMPANY_SELECTORS = [
    "[data-test-job-card-company-name]",
    ".job-card-container__primary-description",
    ".artdeco-entity-lockup__subtitle span[aria-hidden='true']",
    ".artdeco-entity-lockup__subtitle"
  ];
  const TITLE_SELECTORS = [
    ".job-card-list__title--link",
    "[data-test-job-card-title]",
    ".artdeco-entity-lockup__title a",
    "a[href*='/jobs/view/']"
  ];
  let refreshTimer = 0;
  let refreshVersion = 0;
  let pendingSnapshotRefresh = false;
  let dismissTimer = 0;
  let dismissBusy = false;
  const dismissQueue = new Map();
  const attemptedJobs = new Set();
  const pendingJobs = new Set();
  const DISMISS_SELECTOR = "button[aria-label^='Dismiss '], button[aria-label='Dismiss']";
  const capturedJobs = new Set();
  let captureSelection = null;
  let captureTimer = 0;
  let collection = null;
  let collectionSelecting = false;
  let collectionSelection = null;
  let collectionResultsScroller = null;
  let collectionColumnBounds = null;
  let collectionStartVersion = 0;
  let collectionNotice = null;
  let collectionNoticeTimer = 0;
  let collectionNoticeKey = "";
  let collectionWaiting = null;
  let collectionId = "";

  scheduleClassification(250);
  // Reclassify each tab on a timer, but let the shared background snapshot
  // decide whether its one central Sheet refresh is due. Forcing a refresh
  // from every open LinkedIn tab can exhaust the Google Sheets read quota.
  setInterval(() => scheduleClassification(0), 30_000);
  const observer = new MutationObserver(() => {
    scheduleClassification(350);
    if (captureSelection) scheduleCapture(0);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => {
    scheduleClassification(0);
    if (captureSelection) scheduleCapture(0);
  });
  document.addEventListener("scroll", () => scheduleClassification(350), { capture: true, passive: true });
  document.addEventListener("click", onCardClick, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (collection?.running() || collectionWaiting)) stopCollection();
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.isTrusted && (collection?.running() || collectionWaiting) && !event.target?.closest?.("[data-job-tracker-collection]") &&
      event.target?.closest?.("button, a, input, select, [role='button']")) stopCollection("Stopped — you took control of the page.");
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "KAI_TRACKER_RUN_STOP") {
      stopCollection();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KAI_TRACKER_RUN_START") {
      void resumeCollection(message.state?.id).then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: error.message })
      );
      return true;
    }
    if (message?.type === "KAI_TRACKER_REFRESH_STYLES") {
      scheduleClassification(0);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "SCRAPE_LINKEDIN_JOB") return undefined;
    try {
      const scraper = window.LinkedInJobScraper;
      if (!scraper?.scrape) throw new Error("Scraper module is not available on this page.");
      sendResponse({ ok: true, data: scraper.scrape(document, window.location.href) });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  });

  function scheduleClassification(delay, { refresh = false } = {}) {
    pendingSnapshotRefresh ||= refresh;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const refreshSnapshot = pendingSnapshotRefresh;
      pendingSnapshotRefresh = false;
      void classifyVisibleCards({ refresh: refreshSnapshot });
    }, delay);
  }

  async function classifyVisibleCards({ refresh = false } = {}) {
    const version = ++refreshVersion;
    const cards = uniqueCards();
    const records = cards.map(readCard).filter((record) => record.company);
    const companies = [...new Map(records.map((record) => [companyKey(record.company), record.company])).values()];

    // LinkedIn recycles list nodes while scrolling. Clear a stale state only
    // when the company occupying that node actually changes; retaining the
    // previous state while the central check is in flight prevents flicker.
    for (const record of records) {
      const key = companyKey(record.company);
      if (record.card.getAttribute("data-kai-flow-company-key") !== key) {
        clearCardState(record.card);
        record.card.setAttribute("data-kai-flow-company-key", key);
      }
    }
    if (!companies.length) return;

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies, refresh });
    } catch {
      return;
    }
    if (version !== refreshVersion || !response?.ok) return;
    const classifications = new Map((response.result?.companies || [])
      .filter(Boolean)
      .map((item) => [companyKey(item.company), item]));

    for (const record of records) {
      if (!sameJob(record)) continue;
      const match = classifications.get(companyKey(record.company));
      if (match?.banned) setCardState(record.card, "banned");
      else if (match?.duplicate) setCardState(record.card, "duplicate");
      else clearCardState(record.card);
      if (match?.banned || match?.duplicate) dismissQueue.set(record.card, record);
      else dismissQueue.delete(record.card);
    }
    scheduleDismissal();
  }

  function readCard(card) {
    const modern = readModernCard(card);
    const company = readFirst(card, COMPANY_SELECTORS) || modern.company;
    const title = readFirst(card, TITLE_SELECTORS) || modern.title;
    const jobId = card.getAttribute("data-occludable-job-id") || card.getAttribute("data-job-id") ||
      card.getAttribute("componentkey") || card.querySelector("a[href*='/jobs/view/']")?.getAttribute("href") || "";
    const captureId = card.getAttribute("data-occludable-job-id") || card.getAttribute("data-job-id") ||
      card.getAttribute("componentkey")?.match(/job-card-component-ref-(\d+)/u)?.[1] ||
      card.querySelector("a[href*='/jobs/view/']")?.getAttribute("href")?.match(/\/jobs\/view\/(\d+)/u)?.[1] || "";
    return { card, company, title, captureId, identity: JSON.stringify([jobId, companyKey(company), title]) };
  }

  function sameJob(record) {
    return record.card.isConnected && readCard(record.card).identity === record.identity;
  }

  function dismissButton(record) {
    const collectorOwnsCard = collection?.running() && ownCollectionSelection(record);
    if ((document.hidden && !collectorOwnsCard) || !sameJob(record) || attemptedJobs.has(record.identity)) return null;
    const button = record.card.querySelector(DISMISS_SELECTOR);
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return null;
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === button || button.contains(hit)) ? button : null;
  }

  function onCardClick(event) {
    // Collector clicks share normal selection/X behavior. The run owns their
    // paced save, so they must not also start the immediate manual capture.
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    let card = target?.closest(CARD_SELECTOR);
    if (!card) return;
    if (!collectionSelecting && event.isTrusted !== false && (collection?.running() || collectionWaiting)) stopCollection("Stopped — you selected a job.");
    // Match the same outer card used by classification in legacy nested lists.
    while (card.parentElement?.closest(CARD_SELECTOR)) card = card.parentElement.closest(CARD_SELECTOR);
    const record = readCard(card);
    const control = target.closest("button");
    if (control) {
      if (control.matches(DISMISS_SELECTOR)) {
        // Also remember direct user clicks on LinkedIn's X, before its DOM
        // changes. Leave the native event alone, including every Undo action.
        attemptedJobs.add(record.identity);
        dismissQueue.delete(card);
      }
      return;
    }
    // User selection authorizes capture. Automatic dismiss clicks, modified
    // links and native controls never start research or save a job.
    if (!collectionSelecting && event.isTrusted !== false && window.LinkedInJobScraper?.scrape && !capturedJobs.has(record.identity) &&
      !["duplicate", "banned"].includes(card.getAttribute("data-kai-flow-job-state"))) {
      let previous;
      try { previous = window.LinkedInJobScraper.scrape(document, window.location.href); } catch { /* Wait for readable details. */ }
      captureSelection = { record, previousId: previous?.jobId, previousDescription: previous?.description,
        expiresAt: Date.now() + 10000, stableValue: "", stableAt: 0 };
      scheduleCapture(0);
    }
    if (collectionSelecting || !dismissButton(record)) return;
    // Let LinkedIn receive the original click and select the job first. A
    // separate task avoids changing its card while that click is propagating.
    // Recheck identity and dismissal state in case selection replaced the DOM.
    setTimeout(() => {
      clickDismissButton(record);
      scheduleDismissal();
    }, 0);
  }

  function scheduleCapture(delay) {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => void captureSelectedJob(), delay);
  }

  async function captureSelectedJob() {
    const selection = captureSelection;
    // A trusted card click already authorized this handoff. Switching away
    // while LinkedIn loads the selected details must not abandon it.
    if (!selection) return;
    if (Date.now() > selection.expiresAt) { captureSelection = null; return; }
    let job;
    try { job = window.LinkedInJobScraper.scrape(document, window.location.href); } catch { scheduleCapture(200); return; }
    const record = selection.record;
    // LinkedIn replaces the details asynchronously. Never capture the previous
    // job, even when it happens to have the same company or role title.
    const cardId = record.captureId;
    if (!cardId || job.jobIdSource === "query" || String(job.jobId) !== String(cardId) || companyKey(job.company) !== companyKey(record.company) ||
      companyKey(job.title) !== companyKey(record.title) || !job.description?.trim()) { scheduleCapture(200); return; }
    if (job.applicationsAvailable === false && !job.applicationsClosed) { scheduleCapture(200); return; }
    // Header and description can update in separate renders. A different job
    // must replace the old description, and the full capture must settle.
    if (String(selection.previousId) !== String(cardId) && selection.previousDescription &&
      job.description === selection.previousDescription) { scheduleCapture(200); return; }
    const stableValue = JSON.stringify([job.jobId, job.company, job.title, job.description, job.workplaceType, job.isEasyApply, job.applicationsClosed]);
    if (selection.stableValue !== stableValue) { selection.stableValue = stableValue; selection.stableAt = Date.now(); scheduleCapture(200); return; }
    if (Date.now() - selection.stableAt < 200) { scheduleCapture(200); return; }
    if (captureSelection !== selection || capturedJobs.has(record.identity)) return;
    captureSelection = null;
    capturedJobs.add(record.identity);
    try {
      await chrome.runtime.sendMessage({ type: "KAI_TRACKER_CAPTURE", job });
    } catch { /* A failed capture does not interfere with native selection. */ }
  }

  function clickDismissButton(record) {
    const button = dismissButton(record);
    if (!button) return;
    // Record before clicking so native X clicks, repeated card clicks and
    // pending automatic checks cannot activate this job a second time.
    attemptedJobs.add(record.identity);
    dismissQueue.delete(record.card);
    const selected = ownCollectionSelection(record);
    if (selected) selected.dismissed = true;
    button.click();
  }

  function scheduleDismissal() {
    if (dismissTimer || dismissBusy || document.hidden || collection?.running() || collectionWaiting) return;
    for (const [card, record] of dismissQueue) {
      if (!sameJob(record) || attemptedJobs.has(record.identity)) dismissQueue.delete(card);
    }
    if (![...dismissQueue.values()].some((record) => !pendingJobs.has(record.identity) && dismissButton(record))) return;
    // Process confirmed jobs consecutively without an intentional delay.
    // Yield between clicks so LinkedIn can finish updating the previous card.
    dismissTimer = setTimeout(() => {
      dismissTimer = 0;
      void dismissNextJob();
    }, 0);
  }

  async function dismissNextJob() {
    if (document.hidden || collection?.running() || collectionWaiting) return;
    const record = [...dismissQueue.values()].find((entry) => !pendingJobs.has(entry.identity) && dismissButton(entry));
    if (!record) return;
    dismissBusy = true;
    try {
      await dismissJob(record);
    } finally {
      dismissBusy = false;
      scheduleDismissal();
    }
  }

  async function dismissJob(record) {
    if (pendingJobs.has(record.identity) || !dismissButton(record)) return;
    pendingJobs.add(record.identity);
    dismissQueue.delete(record.card);
    try {
      // Recheck the latest shared classification before the click. Never force
      // one Sheets read per click, or click a recycled card using old results.
      const response = await chrome.runtime.sendMessage({
        type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies: [record.company], refresh: false
      });
      const match = response?.ok && response.result?.companies?.find((item) =>
        item && companyKey(item.company) === companyKey(record.company));
      const button = dismissButton(record);
      if (!button || collection?.running() || collectionWaiting) return;
      if (!match || (!match.banned && !match.duplicate)) {
        if (response?.ok) clearCardState(record.card);
        return;
      }
      clickDismissButton(record);
    } catch {
      // A failed check leaves the card alone until normal reclassification.
    } finally {
      pendingJobs.delete(record.identity);
    }
  }

  function uniqueCards() {
    const candidates = [...document.querySelectorAll(CARD_SELECTOR)];
    return candidates.filter((card) => !candidates.some((other) => other !== card && other.contains(card)));
  }

  function readFirst(root, selectors) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = cleanText(element?.innerText || element?.textContent || "");
      if (text) return text;
    }
    return "";
  }

  function readModernCard(root) {
    const paragraphs = [...root.querySelectorAll("p")];
    const visibleTitle = root.querySelector("p span[aria-hidden='true']");
    let title = cleanText(visibleTitle?.innerText || visibleTitle?.textContent || "");
    let titleParagraph = visibleTitle?.closest?.("p") || null;

    if (!title) {
      const dismiss = root.querySelector("button[aria-label^='Dismiss '][aria-label$=' job']");
      const label = cleanText(dismiss?.getAttribute?.("aria-label") || "");
      title = label.replace(/^Dismiss\s+/iu, "").replace(/\s+job$/iu, "").trim();
    }
    if (!titleParagraph && title) {
      const normalizedTitle = companyKey(title);
      titleParagraph = paragraphs.find((paragraph) => (
        companyKey(paragraph.innerText || paragraph.textContent || "").includes(normalizedTitle)
      )) || null;
    }

    const titleIndex = titleParagraph ? paragraphs.indexOf(titleParagraph) : -1;
    const company = paragraphs.slice(Math.max(0, titleIndex + 1))
      .map((paragraph) => cleanText(paragraph.innerText || paragraph.textContent || ""))
      .find((value) => value && companyKey(value) !== companyKey(title)) || "";
    return { company, title };
  }

  function cleanText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function companyKey(value) {
    return cleanText(value).toLocaleLowerCase("en-US");
  }

  function clearCardState(card) {
    card.removeAttribute("data-kai-flow-job-state");
  }

  function setCardState(card, state) {
    card.setAttribute("data-kai-flow-job-state", state);
  }

  async function collectionMessage(message) {
    let timer;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage(message),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The tracker did not respond. Collection stopped; no save will be retried.")), 40_000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  function activeCollectionCard(record) {
    const card = record.card;
    const dismissedBySelection = ownCollectionSelection(record)?.dismissed === true;
    // The selected card's own X is expected. It can turn grey or disappear
    // while its details finish loading; that must not cancel its one save.
    if ((card.isConnected ? !sameJob(record) : !dismissedBySelection) || !record.captureId || !record.company || !record.title ||
      capturedJobs.has(record.identity) || ["duplicate", "banned"].includes(card.getAttribute("data-kai-flow-job-state")) ||
      (!dismissedBySelection && (attemptedJobs.has(record.identity) || card.getAttribute("aria-disabled") === "true" || card.getAttribute("aria-hidden") === "true" ||
        card.querySelector("button[aria-label^='Undo' i]") ||
        /we (?:won['’]t|will not) recommend this job anymore|job (?:has been|was) dismissed/iu.test(card.innerText || card.textContent || "")))) return false;
    if (dismissedBySelection) return true;
    const style = window.getComputedStyle(card);
    const bounds = card.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
  }
  function ownCollectionSelection(record) {
    return collectionSelection?.record.card === record.card && collectionSelection.record.identity === record.identity ? collectionSelection : null;
  }
  function resultsScroller() {
    const card = uniqueCards()[0];
    for (let node = card?.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 4 && /auto|scroll/u.test(window.getComputedStyle(node).overflowY)) {
        collectionResultsScroller = node;
        return node;
      }
    }
    return document.querySelector(".jobs-search-results-list, .scaffold-layout__list, .jobs-search-results__list") ||
      (collectionResultsScroller?.isConnected ? collectionResultsScroller : document.scrollingElement);
  }
  function resultsLoading() {
    const scope = resultsScroller();
    return scope?.getAttribute("aria-busy") === "true" || !!scope?.querySelector("[role='progressbar'], .jobs-search-results-list__loader");
  }
  function visibleElement(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function nextResultsPage() {
    const card = uniqueCards()[0];
    const bounds = card?.getBoundingClientRect() || collectionColumnBounds;
    if (!bounds) return null;
    return [...document.querySelectorAll("button, a[role='button']")].find((button) => {
      const name = cleanText(button.getAttribute("aria-label") || button.innerText || button.textContent);
      const rect = button.getBoundingClientRect();
      return /^(?:next|next page|view next page)$/iu.test(name) && !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
        visibleElement(button) && !button.closest("[role='dialog'], [data-job-tracker-collection]") &&
        rect.left < bounds.right && rect.right > bounds.left;
    }) || null;
  }
  function uncovered(element) {
    if (!visibleElement(element)) return false;
    const rect = element.getBoundingClientRect();
    const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === element || element.contains(hit));
  }
  function collectionStatus(message, state, finished = false) {
    const started = message === "Job collection started.";
    const stopped = message === "Job collection stopped." || message.startsWith("Stopped —");
    // Reviewing, saving, scrolling and background pauses remain silent.
    if (!finished && !started && !stopped) return;
    const key = `${state.id}:${message}`;
    if (key === collectionNoticeKey) return;
    collectionNoticeKey = key;
    const tone = started || message === "Job collection stopped." || message.startsWith("Finished —") ? "info"
      : /took control|search changed|did not (?:finish loading|load)|covered|repeated an earlier page/iu.test(message) ? "warning" : "error";
    clearTimeout(collectionNoticeTimer);
    collectionNotice?.remove();
    collectionNotice = document.createElement("div");
    collectionNotice.dataset.jobTrackerCollection = "true";
    collectionNotice.dataset.collectionNotice = tone;
    collectionNotice.setAttribute("role", tone === "info" ? "status" : "alert");
    collectionNotice.textContent = message;
    Object.assign(collectionNotice.style, { position: "fixed", bottom: "18px", right: "18px", zIndex: "2147483647", maxWidth: "360px",
      padding: "12px 14px", borderRadius: "8px", background: { info: "#193044", warning: "#8a5200", error: "#a12622" }[tone],
      color: "#ffffff", font: "13px/1.5 Arial, sans-serif", boxShadow: "0 4px 24px #0005", pointerEvents: "none" });
    document.documentElement.append(collectionNotice);
    collectionNoticeTimer = setTimeout(() => { collectionNotice?.remove(); collectionNotice = null; }, 5000);
  }
  function stopCollection(message = "Job collection stopped.") {
    collectionStartVersion++;
    collection?.stop(message);
    const waiting = collectionWaiting;
    collectionWaiting = null;
    if (waiting) {
      collectionStatus(message, waiting, true);
      void collectionMessage({ type: "KAI_TRACKER_RUN_END", runId: waiting.id }).catch(() => {});
      scheduleDismissal();
    }
  }
  async function waitForCollection(milliseconds, runId) {
    const response = await collectionMessage({ type: "KAI_TRACKER_RUN_WAIT", runId, milliseconds });
    if (!response?.ok) throw new Error(response?.error?.message || "Collection timing is unavailable. Collection stopped.");
    return response.result?.stopped !== true;
  }
  function acquireCollectionLease() {
    if (!window.navigator?.locks?.request) throw new Error("This browser cannot run background collection. Update SunBrowser.");
    return new Promise((resolve, reject) => {
      // One tab owns collection at a time. The lock also keeps Chrome from
      // freezing that owner while its authorized background work is pending.
      window.navigator.locks.request("linkedin-job-tracker-collection", { ifAvailable: true }, (lock) => {
        if (!lock) { reject(new Error("Another collection is still stopping. Try again shortly.")); return; }
        return new Promise((release) => resolve(release));
      }).catch(reject);
    });
  }
  async function resumeCollection(expectedId) {
    if (!window.LinkedInJobCollector) {
      if (expectedId) throw new Error("Reload the extension and LinkedIn tab to load job collection.");
      return;
    }
    const version = ++collectionStartVersion;
    const response = await collectionMessage({ type: "KAI_TRACKER_RUN_STATE" });
    if (!response?.ok) throw new Error(response?.error?.message || "The collection state could not be read.");
    const state = response.result?.state;
    if (version !== collectionStartVersion || !state || (expectedId && expectedId !== state.id)) return;
    if (collection?.running()) {
      if (collectionId === state.id) return;
      await collection.completion();
      if (version !== collectionStartVersion) return;
      return resumeCollection(expectedId);
    }
    const readableCards = () => uniqueCards().map(readCard).filter((record) => record.captureId && record.company && record.title);
    collectionWaiting = { ...state, localVersion: version };
    let releaseLease = () => {}, ready = false;
    try {
      releaseLease = await acquireCollectionLease();
      for (let elapsed = 0; !readableCards().length && elapsed < 15_000; elapsed += 200) {
        if (!await waitForCollection(200, state.id)) return;
        if (version !== collectionStartVersion) return;
        if (window.LinkedInJobCollector.searchKey(window.location.href) !== state.searchKey) throw new Error("The search changed. Job collection stopped.");
      }
      if (!readableCards().length) throw new Error("Results did not finish loading. Job collection stopped.");
      ready = true;
    } catch (error) {
      await collectionMessage({ type: "KAI_TRACKER_RUN_END", runId: state.id });
      collectionStatus(error.message, state, true);
      throw error;
    } finally {
      if (collectionWaiting?.localVersion === version) collectionWaiting = null;
      if (!ready || version !== collectionStartVersion) releaseLease();
    }
    if (version !== collectionStartVersion) return;
    try {
    clearTimeout(captureTimer); captureSelection = null;
    collectionSelection = null;
    collectionResultsScroller = null; collectionColumnBounds = null;
    collectionId = state.id;
    collection = window.LinkedInJobCollector.create({
      searchKey: () => window.LinkedInJobCollector.searchKey(window.location.href),
      wait: waitForCollection,
      cards: () => readableCards().map((record) => ({ ...record, id: record.captureId })),
      activeCard: activeCollectionCard,
      async allowed(record) {
        if (!activeCollectionCard(record)) return false;
        const response = await collectionMessage({ type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies: [record.company], refresh: false });
        if (!response?.ok) throw new Error(response?.error?.message || "Company checks are unavailable. Collection stopped.");
        const match = response.result?.companies?.find((item) => companyKey(item.company) === companyKey(record.company));
        if (!match) throw new Error("Company checks are incomplete. Collection stopped.");
        if (match.banned || match.duplicate) { setCardState(record.card, match.banned ? "banned" : "duplicate"); return false; }
        return activeCollectionCard(record);
      },
      async top() { resultsScroller()?.scrollTo({ top: 0, behavior: "instant" }); },
      async reveal(record) { if (sameJob(record)) record.card.scrollIntoView({ block: "center", behavior: "instant" }); },
      select(record) {
        if (!activeCollectionCard(record) || !uncovered(record.card)) throw new Error("A job card is covered or unavailable. Collection stopped.");
        // Legacy lists wrap the actual selection control in an outer <li>;
        // clicking that wrapper alone does not reach its child's handler.
        const link = record.card.querySelector("a[href*='/jobs/view/']");
        const target = !record.card.matches("[role='button']") && link && visibleElement(link) &&
          (!link.getAttribute("target") || link.getAttribute("target") === "_self") ? link : record.card;
        collectionSelection = { record, dismissed: false };
        collectionColumnBounds = record.card.getBoundingClientRect();
        collectionSelecting = true;
        try { target.click(); } finally { collectionSelecting = false; }
        // The selection event has finished. Dismiss our selected card now,
        // without waiting for a throttled hidden-page timer.
        clickDismissButton(record);
      },
      scrape() { try { return window.LinkedInJobScraper?.scrape(document, window.location.href); } catch { return null; } },
      async capture(job, runId) {
        const response = await collectionMessage({ type: "KAI_TRACKER_CAPTURE", job, runId });
        if (response?.ok) {
          const record = uniqueCards().map(readCard).find((item) => item.captureId === String(job.jobId));
          if (record) capturedJobs.add(record.identity);
        }
        return response;
      },
      async more() {
        if (resultsLoading()) return "loading";
        const scroller = resultsScroller();
        if (scroller && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 4) {
          scroller.scrollTo({ top: Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + Math.max(100, scroller.clientHeight * 0.8)), behavior: "instant" });
          return "scrolled";
        }
        return "bottom";
      },
      loading: resultsLoading,
      pageKey() {
        const page = document.querySelector(".artdeco-pagination [aria-current], [aria-label*='pagination' i] [aria-current], .jobs-search-pagination [aria-current]");
        const start = new URL(window.location.href).searchParams.get("start");
        return start !== null || page ? `start=${start || 0};page=${page?.textContent?.trim() || page?.getAttribute("aria-label") || ""}`
          : uniqueCards().map(readCard).map((record) => record.captureId).join(",");
      },
      next: nextResultsPage,
      async revealNext(next) { next.scrollIntoView({ block: "center", behavior: "instant" }); },
      async goNext(next) {
        if (next !== nextResultsPage() || !uncovered(next)) throw new Error("The next-page control changed or is covered. Collection stopped.");
        collectionSelecting = true;
        try { next.click(); } finally { collectionSelecting = false; }
      },
      status: collectionStatus,
      async checkpoint(state) {
        const response = await collectionMessage({ type: "KAI_TRACKER_RUN_CHECKPOINT", runId: state.id, state });
        if (!response?.ok) throw new Error(response?.error?.message || "Collection progress could not be saved.");
        if (response.result?.stopped) collection.stop();
      },
      async finished(runId) {
        await collectionMessage({ type: "KAI_TRACKER_RUN_END", runId });
        if (collectionId === runId) collectionSelection = null;
        // Resume native duplicate/banned dismissal only after the paced run.
        setTimeout(() => scheduleDismissal(), 0);
      }
    });
    collection.start(state);
    void collection.completion().then(releaseLease, releaseLease);
    } catch (error) {
      releaseLease();
      await collectionMessage({ type: "KAI_TRACKER_RUN_END", runId: state.id });
      throw error;
    }
  }
  if (window.LinkedInJobCollector) void resumeCollection().catch(() => {});

})();
