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

  installStyles();
  scheduleClassification(250);
  // Reclassify each tab on a timer, but let the shared background snapshot
  // decide whether its one central Sheet refresh is due. Forcing a refresh
  // from every open LinkedIn tab can exhaust the Google Sheets read quota.
  setInterval(() => scheduleClassification(0), 30_000);
  const observer = new MutationObserver(() => scheduleClassification(350));
  observer.observe(document.documentElement, { childList: true, subtree: true });

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
    const records = cards.map((card) => {
      const modern = readModernCard(card);
      return {
        card,
        company: readFirst(card, COMPANY_SELECTORS) || modern.company,
        title: readFirst(card, TITLE_SELECTORS) || modern.title
      };
    }).filter((record) => record.company);
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
      const match = classifications.get(companyKey(record.company));
      if (match?.banned) setCardState(record.card, "banned");
      else if (match?.duplicate) setCardState(record.card, "duplicate");
      else clearCardState(record.card);
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
