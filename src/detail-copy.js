(function registerJobDetailCopy() {
  if (window.__KAI_TRACKER_DETAIL_COPY__) return;
  window.__KAI_TRACKER_DETAIL_COPY__ = true;

  const CARDS = "li[data-occludable-job-id],li.jobs-search-results__list-item,.job-card-container,[data-view-name='job-card'],[componentkey^='job-card-component-ref-']";
  const ROOTS = ".jobs-search__job-details--container,.jobs-search__job-details-container,[data-sdui-screen*='JobDetails'],.job-view-layout";
  const TITLES = ".job-details-jobs-unified-top-card__job-title,.jobs-unified-top-card__job-title,h1,[data-test-job-title],[data-testid='job-title']";
  const COMPANIES = ".job-details-jobs-unified-top-card__company-name,.jobs-unified-top-card__company-name";
  const marked = new Map();
  let scanTimer;
  let feedbackTimer;
  let feedback;
  let copyVersion = 0;

  const style = document.createElement("style");
  style.textContent = `
    [data-kai-copy-field] { cursor: copy !important; }
    [data-kai-copy-field]:hover { text-decoration: underline dotted !important; text-underline-offset: 3px; }
    [data-kai-copy-field]:focus-visible { outline: 2px solid #0a66c2; outline-offset: 3px; }
    #kai-tracker-copy-feedback { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; padding: 10px 16px; border-radius: 8px; background: #202124; color: white;
      font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 2px 8px #0003; pointer-events: none; }
  `;
  (document.head || document.documentElement).append(style);

  function text(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll("svg,button,img,.visually-hidden,.sr-only,[hidden]").forEach((node) => node.remove());
    clone.querySelectorAll("br").forEach((node) => node.replaceWith(document.createTextNode(" ")));
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function scan() {
    scanTimer = undefined;
    const targets = new Map();
    const roots = [...document.querySelectorAll(ROOTS)];
    if (!roots.length) roots.push(document.querySelector("main") || document.body);
    for (const root of roots.filter(Boolean)) {
      const heading = [...root.querySelectorAll(TITLES)].find((node) => !node.closest(CARDS) && text(node)) ||
        [...root.querySelectorAll("a[href*='/jobs/view/']")].find((node) => !node.closest(CARDS) && text(node));
      if (!heading) continue;
      targets.set(heading, "title");
      let company = [...root.querySelectorAll(COMPANIES)].find((node) => !node.closest(CARDS) && text(node));
      // Modern LinkedIn uses generated classes. Find the text company link in
      // the nearest header containing this title, excluding logo-only links.
      for (let parent = heading.parentElement; !company && parent && root.contains(parent); parent = parent.parentElement) {
        company = [...parent.querySelectorAll("a[href*='/company/']")]
          .find((node) => !node.closest(CARDS) && text(node));
        if (parent === root) break;
      }
      if (company) targets.set(company, "company");
    }
    for (const [node, original] of marked) {
      if (targets.has(node)) continue;
      node.removeAttribute("data-kai-copy-field");
      for (const [name, value] of Object.entries(original)) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
      marked.delete(node);
    }
    for (const [node, field] of targets) {
      if (!marked.has(node)) marked.set(node, Object.fromEntries(
        ["title", "tabindex", "role"].map((name) => [name, node.getAttribute(name)])));
      node.setAttribute("data-kai-copy-field", field);
      node.setAttribute("title", `Click to copy ${field === "title" ? "job title" : "company name"}`);
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
    }
  }

  function scheduleScan() {
    if (scanTimer !== undefined) return;
    scanTimer = setTimeout(scan, 0);
  }

  function showFeedback(message) {
    clearTimeout(feedbackTimer);
    if (!feedback?.isConnected) {
      feedback = document.createElement("div");
      feedback.id = "kai-tracker-copy-feedback";
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      document.body.append(feedback);
    }
    feedback.textContent = message;
    feedbackTimer = setTimeout(() => feedback.remove(), 1800);
  }

  async function writeClipboard(value) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch { /* Fall back when this page cannot use the asynchronous clipboard. */ }
    const input = document.createElement("textarea");
    input.value = value;
    input.readOnly = true;
    input.style.cssText = "position:fixed;left:-10000px;top:0";
    const focused = document.activeElement;
    document.body.append(input);
    try {
      input.select();
      if (!document.execCommand?.("copy")) throw new Error("Clipboard unavailable");
    } finally {
      input.remove();
      focused?.focus?.({ preventScroll: true });
    }
  }

  function onCopy(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.type === "click" ? event.button !== 0 : !["Enter", " "].includes(event.key)) return;
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const node = target?.closest("[data-kai-copy-field]");
    if (!node || !marked.has(node) || node.closest(CARDS) || target.closest("button")) return;
    const field = node.getAttribute("data-kai-copy-field");
    const raw = text(node);
    const clean = window.LinkedInJobScraper?._internals?.[field === "title" ? "cleanTitle" : "cleanCompany"];
    const value = clean ? clean(raw) : raw;
    if (!value) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const version = ++copyVersion;
    void writeClipboard(value).then(() => {
      if (version === copyVersion) showFeedback(field === "title" ? "Job title copied" : "Company name copied");
    }, () => {
      if (version === copyVersion) showFeedback("Could not copy. Select the text and copy it manually.");
    });
  }

  document.addEventListener("click", onCopy, true);
  document.addEventListener("keydown", onCopy, true);
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  scan();
})();
