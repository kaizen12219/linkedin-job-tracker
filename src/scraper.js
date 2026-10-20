(function exposeLinkedInJobScraper() {
  const ABOUT_HEADING_PATTERNS = [
    /^about the job\s*:?$/i,
    /^job description\s*:?$/i,
    /^about this role\s*:?$/i,
    /^about the role\s*:?$/i,
    /^acerca del empleo\s*:?$/i,
    /^descripci[oó]n del empleo\s*:?$/i,
    /^sobre el empleo\s*:?$/i
  ];

  const APPLY_PATTERNS = [
    /\bapply\b/i,
    /\beasy apply\b/i,
    /\bsolicitar\b/i,
    /\bpostular\b/i,
    /\bcandidatar\b/i,
    /\bcandidature\b/i,
    /\bbewerben\b/i
  ];

  const NON_TITLE_PATTERNS = [
    /\bverified\b/i,
    /\bempleo verificado\b/i,
    /\bjob alert\b/i,
    /\bsearch\b/i,
    /\bresults\b/i
  ];

  const NON_COMPANY_PATTERNS = [
    /^click to copy (?:company name|job title)$/i,
    /^(show|see|view|learn)\s+(more|less)(\s+about\s+(the\s+)?company)?\.?$/i,
    /^(follow|following|apply|save|share|search|results|job alert)$/i
  ];

  function scrape(doc = document, sourceUrl = window.location.href) {
    const root = findJobDetailsRoot(doc);
    const titleResult = extractTitle(doc, root);
    const companyResult = extractCompany(doc, root);
    const descriptionResult = extractDescription(doc, root);
    const applyResult = extractApplyUrl(doc, root, sourceUrl);
    const metadata = extractCaptureMetadata(root, descriptionResult.value, sourceUrl, titleResult.value);
    const searchRegion = globalThis.JobProfileRouting?.selectedSearchRegion(doc, sourceUrl) || { region: "", source: "" };

    const payload = {
      title: titleResult.value,
      company: companyResult.value,
      description: descriptionResult.value,
      applyUrl: applyResult.value,
      ...metadata,
      selectedRegion: searchRegion.region,
      selectedRegionSource: searchRegion.source,
      sourceUrl,
      scrapedAt: new Date().toISOString(),
      confidence: {
        title: titleResult.confidence,
        company: companyResult.confidence,
        description: descriptionResult.confidence,
        applyUrl: applyResult.confidence
      },
      selectorsUsed: {
        title: titleResult.source,
        company: companyResult.source,
        description: descriptionResult.source,
        applyUrl: applyResult.source
      },
      warnings: []
    };

    if (applyResult.rawValue && applyResult.rawValue !== applyResult.value) {
      payload.rawApplyUrl = applyResult.rawValue;
    }

    for (const field of ["title", "company", "description", "applyUrl"]) {
      if (!payload[field]) {
        payload.warnings.push(`Missing ${field}.`);
      }
    }

    return payload;
  }

  function findJobDetailsRoot(doc) {
    let recognized = false, pending = null;
    for (const selector of [
      '[data-sdui-screen*="SemanticJobDetails"]',
      '[data-sdui-screen*="JobDetails"]',
      '.jobs-search__job-details--container',
      '.jobs-details',
      '.job-view-layout'
    ]) {
      const candidates = queryAll(doc, selector);
      recognized ||= candidates.length > 0;
      const ready = candidates.find(node => descriptionVisible(node));
      if (ready) return ready;
      pending ||= candidates.find(node => descriptionVisible(node, true));
    }
    if (pending) return pending;
    if (recognized) {
      // A hidden previous panel is not a substitute for the current panel
      // while LinkedIn replaces its details.
      const unavailable = doc.createElement("div"); unavailable.hidden = true;
      return unavailable;
    }
    return descriptionNodes(doc, ['main[role="main"]', 'main', 'body', 'html'])[0] || doc.documentElement;
  }

  function extractCaptureMetadata(root, description, sourceUrl, title) {
    // Only inspect the selected details header. Search filters and other cards
    // can contain Remote/Easy Apply for a different job.
    const cardSelector = "li[data-occludable-job-id], .job-card-container, [data-view-name='job-card'], [componentkey^='job-card-component-ref-']";
    // Some current layouts put the selected title in a standalone link rather
    // than h1/h2. Use that exact title's link, never a search-result card link.
    const selectedTitleLink = queryAll(root, "a[href*='/jobs/view/']").find((node) =>
      !node.closest(cardSelector) && cleanTitle(readElementText(node)) === title);
    const heading = queryFirst(root, ["h1", ".job-details-jobs-unified-top-card__job-title"]) ||
      queryAll(root, "h2, h3").find((node) => queryFirst(node, ["a[href*='/jobs/view/']"])) || selectedTitleLink;
    let header = heading?.parentElement;
    for (let depth = 0; header && depth < 5; depth++, header = header.parentElement) {
      if (header === root || queryAll(header, "button, a").some((node) => /\beasy apply\b|^apply$/iu.test(readElementText(node)))) break;
    }
    const scope = queryFirst(root, [".job-details-jobs-unified-top-card", ".jobs-unified-top-card"]) || header || root;
    const controls = queryAll(scope, "button, a[role='button'], a[href]")
      .filter((node) => !node.closest(cardSelector));
    const isEasyApply = controls.some((node) => /\beasy apply\b/iu.test(`${readElementText(node)} ${node.getAttribute("aria-label") || ""}`));
    const applicationsAvailable = controls.some((node) => !node.disabled && node.getAttribute("aria-disabled") !== "true" &&
      (/\beasy apply\b|^apply(?:\s|$)/iu.test(readElementText(node)) || /\bapply\b/iu.test(node.getAttribute("aria-label") || "")));
    const labels = queryAll(scope, "button, span, li, p").map((node) => readElementText(node).replace(/^[✓✔\s]+/u, ""));
    const workplaceType = labels.some((value) => /^(?:on[- ]site|presencial)$/iu.test(value)) ? "on-site"
      : labels.some((value) => /^(?:hybrid|híbrido)$/iu.test(value)) ? "hybrid"
        : labels.some((value) => /^(?:remote|en remoto)$/iu.test(value)) ? "remote" : "unknown";
    const applicationsClosed = /(?:no longer accepting applications|applications (?:are )?closed|job (?:has )?expired)/iu.test(readElementText(root));
    const posterScope = queryFirst(root, [".hirer-card__hirer-information", ".job-details-jobs-unified-top-card__hirer", "[data-testid='job-poster']", ".jobs-poster"]);
    const posterName = posterScope ? readElementText(queryFirst(posterScope, ["a[href*='/in/']", "h3", "strong"])) : "";
    const descriptionEmails = [...new Set((description.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) || []).map((value) => value.replace(/[.,;]+$/u, "")))];
    const titleLink = selectedTitleLink || (heading && queryFirst(heading, ["a[href*='/jobs/view/']"]));
    const detailsId = (titleLink && titleLink.getAttribute("href")?.match(/\/jobs\/view\/(\d+)/u)?.[1]) ||
      root.getAttribute?.("data-job-id") || root.getAttribute?.("data-entity-urn")?.match(/jobPosting:(\d+)/u)?.[1];
    const pageId = sourceUrl.match(/\/jobs\/view\/(\d+)/u)?.[1];
    const jobId = detailsId || pageId || new URL(sourceUrl).searchParams.get("currentJobId") || "";
    return { isEasyApply, workplaceType, applicationsClosed, applicationsAvailable, posterName, descriptionEmails, jobId,
      jobIdSource: detailsId ? "details" : pageId ? "page" : "query" };
  }

  function extractTitle(doc, root) {
    const explicitHeading = firstMeaningfulText([
      ...queryAll(root, "h1"),
      ...queryAll(doc, '[data-test-job-title], [data-testid*="job-title"]')
    ]);

    if (explicitHeading) {
      return result(cleanTitle(explicitHeading), "heading-or-test-id", 0.95);
    }

    const jobLinks = queryAll(root, 'a[href*="/jobs/view/"]')
      .map((link, index) => ({
        value: cleanTitle(readElementText(link)),
        source: `job-view-link:${index}`,
        score: scoreTitleLink(link, root, index)
      }))
      .filter((candidate) => isPlausibleTitle(candidate.value))
      .sort((a, b) => b.score - a.score);

    if (jobLinks[0]) {
      return result(jobLinks[0].value, jobLinks[0].source, scoreToConfidence(jobLinks[0].score));
    }

    const metaTitle = getMetaContent(doc, ['meta[property="og:title"]', 'meta[name="title"]']);
    const documentTitle = cleanTitle((metaTitle || doc.title || "").split("|")[0]);

    if (isPlausibleTitle(documentTitle)) {
      return result(documentTitle, "document-title", 0.55);
    }

    return result("", "not-found", 0);
  }

  function extractCompany(doc, root) {
    const companyLinks = queryAll(root, 'a[href*="/company/"]')
      .map((link, index) => {
        const label = extractCompanyLabel(link);
        return {
          value: cleanCompany(label),
          source: `company-link:${index}`,
          score: scoreCompanyLink(link, root, index)
        };
      })
      .filter((candidate) => isPlausibleCompany(candidate.value))
      .sort((a, b) => b.score - a.score);

    if (companyLinks[0]) {
      return result(companyLinks[0].value, companyLinks[0].source, scoreToConfidence(companyLinks[0].score));
    }

    const fromLogo = queryAll(root, 'img[alt*="company" i], img[alt*="empresa" i]')
      .map((img) => cleanCompany(normalizeCompanyLabel(img.getAttribute("alt") || "")))
      .find(isPlausibleCompany);

    if (fromLogo) {
      return result(fromLogo, "company-logo-alt", 0.65);
    }

    const documentCompany = extractCompanyFromDocumentTitle(doc);

    if (documentCompany) {
      return result(documentCompany, "document-title", 0.45);
    }

    return result("", "not-found", 0);
  }

  function extractDescription(doc, root) {
    if (!descriptionVisible(root)) return result("", "not-ready", 0);
    const aboutScopes = descriptionNodes(root, [
      '[componentkey^="JobDetails_AboutTheJob"]',
      '[data-sdui-component*="aboutTheJob" i]',
      '[data-testid*="job-description" i]'
    ]);
    for (const scope of aboutScopes) {
      for (const node of descriptionNodes(scope, ['[data-testid="expandable-text-box"]', '.jobs-box__html-content', '.show-more-less-html__markup'])) {
        const value = descriptionText(node);
        if (value) return result(value, "about-section-body", 0.98);
      }
      const value = descriptionText(scope);
      if (value) return result(value, "about-section-content", 0.96);
    }
    // A mounted About section that is still loading must not borrow another
    // widget's text while the selected description finishes hydrating.
    if (aboutScopes.length) return result("", "about-section-not-ready", 0);

    const legacyBodies = descriptionNodes(root, ['.jobs-box__html-content', '.jobs-description-content__text',
      '.jobs-description__content', '.description__text', '.show-more-less-html__markup', '#job-details']);
    for (const node of legacyBodies) {
      const value = descriptionText(node);
      if (value) return result(value, "selected-description-body", 0.94);
    }
    if (legacyBodies.length) return result("", "selected-description-not-ready", 0);

    const heading = findHeading(root, ABOUT_HEADING_PATTERNS);
    if (heading) {
      const value = descriptionAfterHeading(heading, root);
      return result(value, value ? "about-heading-content" : "about-heading-not-ready", value ? 0.9 : 0);
    }

    for (const node of descriptionNodes(root, ['[data-testid="expandable-text-box"]',
      '[data-test-id*="description"]',
      '[aria-label*="Job description" i]',
      '[aria-label*="Description" i]'
    ])) {
      const value = descriptionText(node);
      if (value) return result(value, "selected-description-attribute", 0.7);
    }
    return result("", "not-found", 0);
  }

  const DESCRIPTION_EXCLUDED = "li[data-occludable-job-id], .job-card-container, [data-view-name='job-card'], [componentkey^='job-card-component-ref-'], .job-details-jobs-unified-top-card, .jobs-unified-top-card, nav, aside, [componentkey*='AboutTheCompany'], [componentkey*='SimilarJobs'], [data-sdui-component*='aboutTheCompany' i]";
  const AUTHORED_DESCRIPTION = '[componentkey^="JobDetails_AboutTheJob"], [data-sdui-component*="aboutTheJob" i], [data-testid*="job-description" i], .jobs-box__html-content, .jobs-description-content__text, .jobs-description__content, .description__text, .show-more-less-html__markup, #job-details';
  const OTHER_SECTION = /^(?:about (?:the )?company|company (?:overview|insights)|meet (?:the )?hiring team|similar jobs|recommended jobs|people also viewed|how you match|how your profile|job match|promoted jobs)\b/iu;
  const LOADING_TEXT = /^(?:(?:loading|please wait)(?:\s+(?:the|your|job|description|details|content|for))*\s*[.…!]*|(?:show|see)\s+(?:more|less))$/iu;
  function descriptionVisible(node, allowBusy = false) {
    if (!node || node.closest?.("[hidden], [aria-hidden='true'], [inert], template") || (!allowBusy && node.closest?.("[aria-busy='true']"))) return false;
    const view = node.ownerDocument?.defaultView;
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const style = view?.getComputedStyle(current);
      if (style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") return false;
    }
    return true;
  }
  function unrelatedDescription(node) {
    if (node.closest?.(DESCRIPTION_EXCLUDED)) return true;
    // An employer can include a company introduction inside the actual JD.
    // Only separate widgets are excluded once an authored body is identified.
    if (node.closest?.(AUTHORED_DESCRIPTION)) return false;
    for (let current = node; current; current = current.parentElement) {
      if (!current.matches?.("section, article")) continue;
      const heading = queryFirst(current, ["h1, h2, h3, h4"]);
      if (heading && OTHER_SECTION.test(readElementText(heading))) return true;
    }
    return false;
  }
  function descriptionNodes(root, selectors) {
    const nodes = [];
    for (const selector of selectors) {
      for (const node of [...(root?.matches?.(selector) ? [root] : []), ...queryAll(root, selector)]) {
        if (!nodes.includes(node) && descriptionVisible(node, true) && !unrelatedDescription(node)) nodes.push(node);
      }
    }
    return nodes;
  }
  function descriptionText(node) {
    if (!descriptionVisible(node) || unrelatedDescription(node)) return "";
    const clone = node.cloneNode(true), originals = queryAll(node, "*"), copies = queryAll(clone, "*");
    for (let index = originals.length - 1; index >= 0; index--) {
      if (!descriptionVisible(originals[index]) || originals[index].matches?.(DESCRIPTION_EXCLUDED)) copies[index].remove();
    }
    queryAll(clone, "script, style, svg, button, nav, aside, [role='progressbar'], .artdeco-loader, [data-testid*='skeleton' i]").forEach(element => element.remove());
    for (const heading of queryAll(clone, "h1, h2, h3, h4")) {
      const label = readElementText(heading);
      if (ABOUT_HEADING_PATTERNS.some(pattern => pattern.test(label))) { heading.remove(); continue; }
      if (!OTHER_SECTION.test(label) || clone.matches?.(AUTHORED_DESCRIPTION) || heading.closest(AUTHORED_DESCRIPTION)) continue;
      const section = heading.closest("section, article");
      if (section && section !== clone) { section.remove(); continue; }
      let current = heading;
      while (current.parentElement && current.parentElement !== clone && current.parentElement.children.length === 1) current = current.parentElement;
      while (current) { const next = current.nextElementSibling; current.remove(); current = next; }
    }
    queryAll(clone, "p, span").filter(element => LOADING_TEXT.test(readElementText(element))).forEach(element => element.remove());
    const value = readRichText(clone);
    return LOADING_TEXT.test(cleanText(value)) ? "" : value;
  }
  function descriptionAfterHeading(heading, root) {
    for (let current = heading; current && current !== root; current = current.parentElement) {
      const fragment = heading.ownerDocument.createElement("div");
      for (let sibling = current.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        const firstHeading = sibling.matches?.("h1, h2, h3, h4") ? sibling : queryFirst(sibling, ["h1, h2, h3, h4"]);
        if (unrelatedDescription(sibling) || (firstHeading && OTHER_SECTION.test(readElementText(firstHeading)))) break;
        if (descriptionVisible(sibling)) fragment.append(sibling.cloneNode(true));
      }
      const value = descriptionText(fragment);
      if (value) return value;
      // A named About section with no ready body must not climb out into
      // the next Premium, company, or recommendations section.
      if (current.parentElement?.matches("section, article")) break;
    }
    return "";
  }

  function descriptionTarget(doc = document) {
    const root = findJobDetailsRoot(doc);
    if (!descriptionVisible(root, true)) return null;
    const scopes = descriptionNodes(root, ['[componentkey^="JobDetails_AboutTheJob"]', '[data-sdui-component*="aboutTheJob" i]', '[data-testid*="job-description" i]']);
    if (scopes[0]) return findHeading(scopes[0], ABOUT_HEADING_PATTERNS) || scopes[0];
    const heading = findHeading(root, ABOUT_HEADING_PATTERNS);
    if (heading && descriptionVisible(heading, true) && !unrelatedDescription(heading)) return heading;
    return descriptionNodes(root, ['.jobs-box__html-content', '.jobs-description__content', '.description__text', '#job-details'])[0] || null;
  }

  function extractApplyUrl(doc, root, sourceUrl) {
    const applyCandidates = queryAll(root, "a[href]")
      .map((link, index) => {
        const rawValue = absoluteUrl(link.getAttribute("href"), sourceUrl);
        const label = `${link.getAttribute("aria-label") || ""} ${readElementText(link)}`.trim();
        const value = unwrapLinkedInRedirect(rawValue);

        return {
          value,
          rawValue,
          source: `apply-link:${index}`,
          score: scoreApplyLink(link, rawValue, label, root)
        };
      })
      .filter((candidate) => candidate.value && candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    if (applyCandidates[0]) {
      const candidate = applyCandidates[0];
      return {
        value: candidate.value,
        rawValue: candidate.rawValue,
        source: candidate.source,
        confidence: scoreToConfidence(candidate.score)
      };
    }

    return result("", "not-found", 0);
  }

  function scoreTitleLink(link, root, index) {
    const href = link.getAttribute("href") || "";
    let score = 50;

    if (root?.contains(link)) score += 40;
    if (/\/jobs\/view\//.test(href)) score += 30;
    if (link.closest("[data-sdui-screen]")) score += 20;
    score -= index * 2;

    return score;
  }

  function scoreCompanyLink(link, root, index) {
    let score = 50;
    const ariaLabel = link.getAttribute("aria-label") || "";
    const visibleText = readElementText(link);
    const ariaCompany = extractCompanyFromAriaLabel(ariaLabel);

    if (isNonCompanyLabel(ariaLabel) || (!ariaCompany && isNonCompanyLabel(visibleText))) {
      return -100;
    }

    if (root?.contains(link)) score += 35;
    if (ariaCompany) score += 45;
    else if (/company|empresa/i.test(ariaLabel)) score += 10;
    if (/\/company\/[^/]+\/life\/?/.test(link.pathname)) score += 15;
    score -= index * 2;

    return score;
  }

  function scoreApplyLink(link, href, label, root) {
    let score = 0;
    const normalizedLabel = cleanText(label);
    const hasApplyLabel = APPLY_PATTERNS.some((pattern) => pattern.test(normalizedLabel));
    const isLinkedInSafetyRedirect = /\/safety\/go\//.test(href);

    if (!hasApplyLabel && !isLinkedInSafetyRedirect) {
      return -100;
    }

    if (hasApplyLabel) score += 80;
    if (root?.contains(link)) score += 30;
    if (isLinkedInSafetyRedirect) score += 45;
    if (link.target === "_blank") score += 10;
    if (/\/jobs\/view\//.test(href)) score -= 40;
    if (/\/jobs\/search-results\//.test(href)) score -= 80;
    if (/save|guardar|share|compartir/i.test(normalizedLabel)) score -= 80;

    return score;
  }

  function findHeading(root, patterns) {
    return queryAll(root, "h1, h2, h3, h4")
      .find((heading) => descriptionVisible(heading, true) && !unrelatedDescription(heading) && patterns.some((pattern) => pattern.test(readElementText(heading))));
  }

  function firstMeaningfulText(elements) {
    return elements
      .map(readElementText)
      .map(cleanTitle)
      .find(isPlausibleTitle) || "";
  }

  function queryFirst(root, selectors) {
    for (const selector of selectors) {
      try {
        const element = root?.querySelector?.(selector);

        if (element) {
          return element;
        }
      } catch (error) {
        continue;
      }
    }

    return null;
  }

  function queryAll(root, selector) {
    try {
      return Array.from(root?.querySelectorAll?.(selector) || []);
    } catch (error) {
      return [];
    }
  }

  function getMetaContent(doc, selectors) {
    const meta = queryFirst(doc, selectors);
    return meta?.getAttribute("content") || "";
  }

  function readElementText(element) {
    if (!element) {
      return "";
    }

    return cleanText(element.innerText || element.textContent || "");
  }

  function extractCompanyLabel(link) {
    const ariaCompany = extractCompanyFromAriaLabel(link.getAttribute("aria-label") || "");

    if (ariaCompany) {
      return ariaCompany;
    }

    // Copy-enabled links use title for their interaction hint, not company
    // metadata. Read their visible company text instead.
    const titleCompany = link.getAttribute("data-kai-copy-field") === "company"
      ? "" : cleanCompany(link.getAttribute("title") || "");

    if (isPlausibleCompany(titleCompany)) {
      return titleCompany;
    }

    const nestedText = queryAll(link, "span, p, strong")
      .map(readElementText)
      .map(cleanCompany)
      .find(isPlausibleCompany);

    if (nestedText) {
      return nestedText;
    }

    return cleanCompany(readElementText(link));
  }

  function extractCompanyFromAriaLabel(value) {
    const label = cleanText(value);
    const companyMatch = label.match(/^(company|empresa)\s*[,:\-]\s*(.+?)(?:\.\s*)?$/i);
    const logoMatch = label.match(/^(company logo for|logotipo de empresa para)\s*[,:\-]?\s*(.+?)(?:\.\s*)?$/i);
    const company = cleanCompany(companyMatch?.[2] || logoMatch?.[2] || "");

    return isPlausibleCompany(company) ? company : "";
  }

  function extractCompanyFromDocumentTitle(doc) {
    const metaTitle = getMetaContent(doc, ['meta[property="og:title"]', 'meta[name="title"]']);
    const titleParts = (metaTitle || doc.title || "").split("|").map(cleanText).filter(Boolean);

    for (const part of titleParts) {
      const atCompanyMatch = part.match(/\b(?:at|@)\s+(.+)$/i);
      const company = cleanCompany(atCompanyMatch?.[1] || "");

      if (isPlausibleCompany(company)) {
        return company;
      }
    }

    if (titleParts[1] && !/linkedin/i.test(titleParts[1])) {
      const company = cleanCompany(titleParts[1]);

      if (isPlausibleCompany(company)) {
        return company;
      }
    }

    return "";
  }

  function readRichText(element) {
    if (!element) {
      return "";
    }

    const clone = element.cloneNode(true);
    const ownerDocument = element.ownerDocument || document;

    queryAll(clone, "script, style, svg, button").forEach((node) => node.remove());

    queryAll(clone, "br").forEach((node) => {
      node.replaceWith(ownerDocument.createTextNode("\n"));
    });

    queryAll(clone, "li").forEach((node) => {
      node.prepend(ownerDocument.createTextNode("- "));
      node.append(ownerDocument.createTextNode("\n"));
    });

    queryAll(clone, "p, div, section, article, h1, h2, h3, h4, ul, ol").forEach((node) => {
      node.append(ownerDocument.createTextNode("\n"));
    });

    return cleanMultilineText(clone.textContent || "");
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanMultilineText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function cleanTitle(value) {
    return cleanText(value)
      .replace(/\s*\((verified job|empleo verificado)\)\s*$/i, "")
      .trim();
  }

  function cleanCompany(value) {
    return normalizeCompanyLabel(cleanText(value))
      .replace(/\s*\|\s*LinkedIn\s*$/i, "")
      .trim();
  }

  function normalizeCompanyLabel(value) {
    return cleanText(value)
      .replace(/^(company|empresa)\s*[,:\-]\s*/i, "")
      .replace(/^company logo for\s+/i, "")
      .replace(/^logotipo de empresa para\s+/i, "");
  }

  function isPlausibleTitle(value) {
    return Boolean(
      value &&
      value.length >= 3 &&
      value.length <= 160 &&
      !NON_TITLE_PATTERNS.some((pattern) => pattern.test(value))
    );
  }

  function isPlausibleCompany(value) {
    return Boolean(
      value &&
      value.length >= 2 &&
      value.length <= 120 &&
      !/linkedin/i.test(value) &&
      !isNonCompanyLabel(value)
    );
  }

  function isNonCompanyLabel(value) {
    const label = cleanText(value);
    return Boolean(label && NON_COMPANY_PATTERNS.some((pattern) => pattern.test(label)));
  }

  function absoluteUrl(href, baseUrl) {
    try {
      return new URL(href, baseUrl).href;
    } catch (error) {
      return "";
    }
  }

  function unwrapLinkedInRedirect(href) {
    try {
      const url = new URL(href);
      const isLinkedIn = url.hostname.endsWith("linkedin.com");
      const redirectedUrl = url.searchParams.get("url");

      if (isLinkedIn && redirectedUrl && /\/safety\/go\/?$/i.test(url.pathname)) {
        return new URL(redirectedUrl).href;
      }

      return url.href;
    } catch (error) {
      return href || "";
    }
  }

  function scoreToConfidence(score) {
    return Math.max(0.1, Math.min(0.99, Number((score / 150).toFixed(2))));
  }

  function result(value, source, confidence) {
    return {
      value: value || "",
      source,
      confidence
    };
  }

  window.LinkedInJobScraper = {
    scrape,
    descriptionTarget,
    _internals: {
      cleanCompany,
      cleanTitle,
      readRichText,
      unwrapLinkedInRedirect
    }
  };
})();
