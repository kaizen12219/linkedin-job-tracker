(function registerLinkedInJobScraperContentScript() {
  if (window.__LINKEDIN_JOB_SCRAPER_CONTENT_READY__) {
    return;
  }

  window.__LINKEDIN_JOB_SCRAPER_CONTENT_READY__ = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SCRAPE_LINKEDIN_JOB") {
      return undefined;
    }

    try {
      const scraper = window.LinkedInJobScraper;

      if (!scraper?.scrape) {
        throw new Error("Scraper module is not available on this page.");
      }

      sendResponse({ ok: true, data: scraper.scrape(document, window.location.href) });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }

    return true;
  });
})();
