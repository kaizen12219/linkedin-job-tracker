(function exposeJobrightScraper(root) {
  "use strict";
  const ID = /^[a-f0-9]{24}$/u;
  const CARD = ".job-card-flag-classname[id]";
  const clean = (value) => String(value || "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
  const text = (node) => clean(node?.innerText || node?.textContent);
  function jobId(value) {
    try {
      const url = new URL(value, "https://jobright.ai");
      return url.protocol === "https:" && /^(?:www\.)?jobright\.ai$/u.test(url.hostname)
        ? url.pathname.match(/^\/jobs\/info\/([a-f0-9]{24})\/?$/u)?.[1] || "" : "";
    } catch { return ""; }
  }
  function detailBackdrop(doc, sourceUrl) {
    if (!jobId(sourceUrl)) return null;
    const lists = [...doc.querySelectorAll("#jobs-page-main-content [class*='index_jobs-list__'][class*='index_jobs-list-leave__']")];
    return lists.length === 1 ? lists[0] : null;
  }
  function visible(node, backdrop = null) {
    if (!node || node.closest("[hidden], [aria-hidden='true'], template")) return false;
    const view = node.ownerDocument?.defaultView;
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const style = view?.getComputedStyle(current);
      // Jobright collapses and fades the committed results while details are
      // open. Its mounted filters/cards still belong to the same search.
      if (style?.display === "none" || style?.visibility === "hidden" || (style?.opacity === "0" && current !== backdrop)) return false;
    }
    return true;
  }
  function searchContext(doc = document, sourceUrl = root.location?.href) {
    let valid = false;
    try { const url = new URL(sourceUrl); valid = url.protocol === "https:" && /^(?:www\.)?jobright\.ai$/u.test(url.hostname) && /^\/jobs\/(?:recommend|info\/[a-f0-9]{24})\/?$/u.test(url.pathname); } catch { /* Unsupported page. */ }
    if (!valid) return { filterKey: "", selectedRegion: "", selectedRegionSource: "" };
    const backdrop = detailBackdrop(doc, sourceUrl);
    const readable = (node) => visible(node, backdrop);
    const preferences = new Map();
    const draft = "[role='dialog'], [role='listbox'], [role='menu'], [aria-modal='true'], [popover], [inert], .ant-popover, .ant-dropdown, .ant-modal, [data-slot='popover-content'], [data-radix-popper-content-wrapper]";
    for (const control of doc.querySelectorAll("[data-preference-key]")) {
      if (!readable(control) || control.closest(draft)) continue;
      const measure = control.getAttribute("data-preference-measure");
      if (measure && measure !== "item") continue;
      const button = [...control.querySelectorAll("button")].find((item) => readable(item) && !item.closest(draft) && item.closest("[data-preference-key]") === control);
      if (!button) continue;
      const valueNodes = [...button.querySelectorAll("[class*='TopbarButton_topbar-button-value']")].filter(readable);
      // Default filters need not have the active state. Require the observed
      // topbar markers so a preference editor cannot masquerade as a filter.
      if (!control.hasAttribute("data-topbar-state") && measure !== "item" && !button.hasAttribute("data-topbar-kind") && !valueNodes.length) continue;
      const labelNodes = valueNodes.length ? valueNodes : [...button.querySelectorAll("span[title]")].filter((item) => readable(item) && !item.closest("svg, [role='img']"));
      const labels = [...new Set(labelNodes.map((item) => clean(item.getAttribute("title")) || text(item)).filter(Boolean))];
      if (!labels.length) {
        // Ignore icon labels such as "setting" when the button has plain text.
        const walker = doc.createTreeWalker(button, 4);
        const parts = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (readable(node.parentElement) && !node.parentElement.closest("svg, [role='img']")) parts.push(node.textContent);
        }
        const label = clean(parts.join(" "));
        if (label) labels.push(label);
      }
      const key = clean(control.getAttribute("data-preference-key"));
      if (key && labels.length) {
        const values = preferences.get(key) || new Set();
        labels.forEach((label) => values.add(label));
        preferences.set(key, values);
      }
    }
    const countries = [...(preferences.get("country") || [])];
    if (countries.length !== 1) return { filterKey: "", selectedRegion: "", selectedRegionSource: "" };
    const country = countries[0];
    const selectedRegion = /^(?:United States(?: of America)?|U\.?S\.?A?\.?)$/iu.test(country) ? "us" : "";
    const pairs = [...preferences].map(([key, values]) => [key, [...values].sort().join(", ")]).sort(([a], [b]) => a.localeCompare(b));
    return { filterKey: country ? `jobright:${JSON.stringify(pairs)}` : "",
      selectedRegion, selectedRegionSource: selectedRegion ? "search-control" : "" };
  }
  function cards(doc = document) {
    const backdrop = detailBackdrop(doc, doc.defaultView?.location?.href);
    return [...doc.querySelectorAll(CARD)].filter((card) => visible(card, backdrop)).map((card) => {
      const id = card.getAttribute("id") || "";
      if (!ID.test(id)) return null;
      const heading = card.querySelector("h2[class*='index_job-title__']");
      const link = heading?.closest("a[href]");
      if (!link || !card.contains(link) || jobId(link.getAttribute("href")) !== id) return null;
      const title = text(heading), company = text(card.querySelector("[class*='index_company-name__']"));
      if (!title || !company) return null;
      return { card, link, id, captureId: id, title, company, identity: JSON.stringify([id, company.toLocaleLowerCase("en-US"), title]) };
    }).filter(Boolean);
  }
  function sectionText(overview) {
    if (!overview) return "";
    const headings = [...overview.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible);
    const pieces = [];
    for (let index = 0; index < headings.length; index++) {
      const heading = headings[index];
      const name = text(heading).replace(/:$/u, "");
      if (!/^(?:Responsibilities|Key Responsibilities|Required|Required Qualifications|Requirements|Preferred|Preferred Qualifications|Benefits)$/iu.test(name)) continue;
      const knownSection = /^(?:Required|Preferred)(?: Qualifications)?$/iu.test(name) ? heading.parentElement
        : heading.closest("section[class*='index_sectionContent__']");
      const range = overview.ownerDocument.createRange();
      range.setStartAfter(heading);
      if (headings[index + 1]) range.setEndBefore(headings[index + 1]); else range.setEnd(overview, overview.childNodes.length);
      const fragment = knownSection || range.cloneContents();
      const explicit = [...fragment.querySelectorAll("span[class*='index_listText__']")];
      const candidates = explicit.length ? explicit : [...fragment.querySelectorAll("li,p")];
      const rows = [...new Set(candidates.filter((node) => !node.closest("[hidden], [aria-hidden='true'], [class*='insider'], [class*='connection']") && visible(node)).map(text).filter(Boolean))];
      if (rows.length) pieces.push(`${name}\n${rows.map((row) => `- ${row}`).join("\n")}`);
    }
    return pieces.join("\n\n");
  }
  function scrape(doc = document, sourceUrl = root.location?.href) {
    const id = jobId(sourceUrl);
    if (!id) throw new Error("Open a Jobright job's details before saving it.");
    const context = searchContext(doc, sourceUrl);
    if (context.selectedRegion !== "us" || context.selectedRegionSource !== "search-control") throw new Error("Select United States in Jobright's country filter before saving or collecting jobs.");
    const heading = [...doc.querySelectorAll("h1[class*='index_job-title__']")].find(visible);
    const companyJob = heading?.closest("[class*='index_company-job__']");
    const title = text(heading);
    const company = text(companyJob?.querySelector("h2")).replace(/\s*[·•]\s*.*$/u, "").trim();
    const detail = heading?.closest("[class*='index_jobDetailContent__']");
    const overview = [...(detail?.querySelectorAll("#overview-1") || [])].find(visible);
    if (!title || !company || !overview) throw new Error("Jobright's selected job details are not ready.");
    const description = sectionText(overview);
    if (!description) throw new Error("The selected job's responsibilities or qualifications are not readable yet.");
    const panel = heading.closest("[class*='index_jobMainContentInfo']") || heading.closest("[class*='index_jobSimpleIntroduction']")?.parentElement || companyJob.parentElement;
    const detailIds = [...new Set([...panel.querySelectorAll("[data-time-filter-job]")].map((node) => node.getAttribute("data-time-filter-job")).filter((value) => ID.test(value || "")))];
    // The SPA updates its URL before the detail fetch finishes. The observed
    // metadata carries the rendered detail's ID, unlike the navigation URL.
    if (detailIds.length !== 1 || detailIds[0] !== id) throw new Error("Jobright's selected job details are still changing.");
    const closed = /(?:no longer accepting applications|this job (?:has )?expired|applications (?:are )?closed|job (?:is )?no longer available)/iu.test(text(detail));
    const applyButton = detail.querySelector("#apply-now-button-id");
    const applicationsAvailable = !closed && !!applyButton && !applyButton.disabled && applyButton.getAttribute("aria-disabled") !== "true";
    const original = [...detail.querySelectorAll("a[href]")].find((anchor) => /^Original Job Post$/iu.test(text(anchor)));
    let applyUrl = `https://jobright.ai/jobs/info/${id}`;
    if (original) {
      try {
        const url = new URL(original.getAttribute("href"), sourceUrl);
        const external = root.JobCapturePolicy?.publicUrl(url.href);
        if (external) applyUrl = external;
      } catch { /* Retain the portal reference. */ }
    }
    const selectedCard = cards(doc).find((record) => record.id === id);
    if (selectedCard && (selectedCard.title !== title || selectedCard.company !== company)) throw new Error("Jobright's selected job details are still changing.");
    const remote = panel.querySelector(`[data-time-filter-job='${id}'][data-time-filter-field='workModel']`) ||
      selectedCard?.card.querySelector("[class*='index_job-metadata-item__'] svg[aria-label='remote']")?.closest("[class*='index_job-metadata-item__']");
    const remoteLabel = text(remote);
    const workplaceType = /\bhybrid\b/iu.test(remoteLabel) ? "hybrid" : /\bremote\b/iu.test(remoteLabel) ? "remote" : /\bon[ -]?site\b/iu.test(remoteLabel) ? "on-site" : "unknown";
    return { jobId: id, jobIdSource: "details", title, company, description, applyUrl,
      sourceUrl: `https://jobright.ai/jobs/info/${id}`, selectedRegion: context.selectedRegion, selectedRegionSource: context.selectedRegionSource,
      searchContextKey: context.filterKey, workplaceType, isEasyApply: !root.JobCapturePolicy?.publicUrl(applyUrl), applicationsAvailable, applicationsClosed: closed,
      descriptionEmails: [...new Set(description.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) || [])],
      scrapedAt: new Date().toISOString(), confidence: { title: "high", company: "high", description: "high", applyUrl: original ? "high" : "low" },
      selectorsUsed: { title: "jobright-detail-heading", company: "jobright-detail-company", description: "jobright-overview-sections", applyUrl: original ? "jobright-original-post" : "jobright-reference" }, warnings: [] };
  }
  const api = Object.freeze({ scrape, cards, searchContext, jobId });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.JobrightJobScraper = api;
})(typeof globalThis === "undefined" ? this : globalThis);
