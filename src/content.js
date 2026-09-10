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

  installStyles();
  scheduleClassification(250);
  // Reclassify each tab on a timer, but let the shared background snapshot
  // decide whether its one central Sheet refresh is due. Forcing a refresh
  // from every open LinkedIn tab can exhaust the Google Sheets read quota.
  setInterval(() => scheduleClassification(0), 30_000);
  const observer = new MutationObserver(() => scheduleClassification(350));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => scheduleClassification(0));
  document.addEventListener("scroll", () => scheduleClassification(350), { capture: true, passive: true });
  document.addEventListener("click", onCardClick, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    return { card, company, title, identity: JSON.stringify([jobId, companyKey(company), title]) };
  }

  function sameJob(record) {
    return record.card.isConnected && readCard(record.card).identity === record.identity;
  }

  function dismissButton(record) {
    if (document.hidden || !sameJob(record) || attemptedJobs.has(record.identity)) return null;
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
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    let card = target?.closest(CARD_SELECTOR);
    if (!card) return;
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
    if (!dismissButton(record)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // A user's card click dismisses any job immediately, independently of
    // Sheet classification. It can also complete an automatic check in flight.
    clickDismissButton(record);
    scheduleDismissal();
  }

  function clickDismissButton(record) {
    const button = dismissButton(record);
    if (!button) return;
    // Record before clicking so native X clicks, repeated card clicks and
    // pending automatic checks cannot activate this job a second time.
    attemptedJobs.add(record.identity);
    dismissQueue.delete(record.card);
    button.click();
  }

  function scheduleDismissal() {
    if (dismissTimer || dismissBusy || document.hidden) return;
    for (const [card, record] of dismissQueue) {
      if (!sameJob(record) || attemptedJobs.has(record.identity)) dismissQueue.delete(card);
    }
    if (![...dismissQueue.values()].some((record) => !pendingJobs.has(record.identity) && dismissButton(record))) return;
    // One native dismiss-button activation at a time, with a new pause before
    // each attempt. These are programmatic clicks, not trusted human input.
    dismissTimer = setTimeout(() => {
      dismissTimer = 0;
      void dismissNextJob();
    }, 1500 + Math.floor(Math.random() * 3001));
  }

  async function dismissNextJob() {
    if (document.hidden) return;
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
      // Recheck the latest shared classification after the delay. Never force
      // one Sheets read per click, or click a recycled card using old results.
      const response = await chrome.runtime.sendMessage({
        type: "KAI_TRACKER_CLASSIFY_COMPANIES", companies: [record.company], refresh: false
      });
      const match = response?.ok && response.result?.companies?.find((item) =>
        item && companyKey(item.company) === companyKey(record.company));
      const button = dismissButton(record);
      if (!button) return;
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

  function installStyles() {
    if (document.querySelector("#kai-flow-linkedin-job-styles")) return;
    const style = document.createElement("style");
    style.id = "kai-flow-linkedin-job-styles";
    style.textContent = `
      [data-kai-flow-job-state] > * {
        opacity: .3 !important;
        transition: none !important;
      }
    `;
    (document.head || document.documentElement).append(style);
  }
})();
