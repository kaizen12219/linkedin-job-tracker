(function exposeLinkedInJobScraper() {
  const ABOUT_HEADING_PATTERNS = [
    /\babout the job\b/i,
    /\bjob description\b/i,
    /\babout this role\b/i,
    /\babout the role\b/i,
    /\bacerca del empleo\b/i,
    /\bdescripci[oó]n del empleo\b/i,
    /\bsobre el empleo\b/i
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

  function scrape(doc = document, sourceUrl = window.location.href) {
    const root = findJobDetailsRoot(doc);
    const titleResult = extractTitle(doc, root);
    const companyResult = extractCompany(doc, root);
    const descriptionResult = extractDescription(doc, root);
    const applyResult = extractApplyUrl(doc, root, sourceUrl);

    const payload = {
      title: titleResult.value,
      company: companyResult.value,
      description: descriptionResult.value,
      applyUrl: applyResult.value,
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
    return queryFirst(doc, [
      '[data-sdui-screen*="SemanticJobDetails"]',
      '[data-sdui-screen*="JobDetails"]',
      'main[role="main"]',
      "main"
    ]) || doc.body || doc.documentElement;
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
        const label = readElementText(link) || normalizeCompanyLabel(link.getAttribute("aria-label") || "");
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

    const titleParts = (doc.title || "").split("|").map(cleanText).filter(Boolean);

    if (titleParts[1] && !/linkedin/i.test(titleParts[1])) {
      return result(cleanCompany(titleParts[1]), "document-title", 0.45);
    }

    return result("", "not-found", 0);
  }

  function extractDescription(doc, root) {
    const aboutScope = queryFirst(doc, [
      '[componentkey^="JobDetails_AboutTheJob"]',
      '[data-sdui-component*="aboutTheJob"]',
      '[data-testid*="job-description"]',
      '[id*="job-details"]'
    ]);

    const scopedTextBox = aboutScope ? queryFirst(aboutScope, ['[data-testid="expandable-text-box"]']) : null;

    if (scopedTextBox) {
      return result(readRichText(scopedTextBox), "about-section-expandable-text-box", 0.98);
    }

    const heading = findHeading(root || doc, ABOUT_HEADING_PATTERNS) || findHeading(doc, ABOUT_HEADING_PATTERNS);
    const textBoxNearHeading = heading ? findTextBoxNearHeading(heading) : null;

    if (textBoxNearHeading) {
      return result(readRichText(textBoxNearHeading), "heading-near-expandable-text-box", 0.9);
    }

    const longestExpandable = queryAll(doc, '[data-testid="expandable-text-box"]')
      .map((element, index) => ({
        element,
        text: readRichText(element),
        source: `expandable-text-box:${index}`
      }))
      .filter((candidate) => candidate.text.length > 120)
      .sort((a, b) => b.text.length - a.text.length)[0];

    if (longestExpandable) {
      return result(longestExpandable.text, longestExpandable.source, 0.7);
    }

    const linkedInDescription = queryFirst(doc, [
      '[data-test-id*="description"]',
      '[aria-label*="Job description" i]',
      '[aria-label*="Description" i]'
    ]);

    if (linkedInDescription) {
      return result(readRichText(linkedInDescription), "description-attribute", 0.6);
    }

    return result("", "not-found", 0);
  }

  function extractApplyUrl(doc, root, sourceUrl) {
    const applyCandidates = queryAll(root, "a[href]")
      .concat(queryAll(doc, "a[href]"))
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

    if (root?.contains(link)) score += 35;
    if (/company|empresa/i.test(ariaLabel)) score += 25;
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
      .find((heading) => patterns.some((pattern) => pattern.test(readElementText(heading))));
  }

  function findTextBoxNearHeading(heading) {
    let current = heading.parentElement;

    for (let depth = 0; current && depth < 8; depth += 1) {
      const textBox = queryFirst(current, ['[data-testid="expandable-text-box"]']);

      if (textBox && textBox !== heading) {
        return textBox;
      }

      const siblingTextBox = findFollowingTextBox(current);

      if (siblingTextBox) {
        return siblingTextBox;
      }

      current = current.parentElement;
    }

    return null;
  }

  function findFollowingTextBox(element) {
    let sibling = element.nextElementSibling;

    while (sibling) {
      const direct = sibling.matches?.('[data-testid="expandable-text-box"]') ? sibling : null;
      const nested = queryFirst(sibling, ['[data-testid="expandable-text-box"]']);

      if (direct || nested) {
        return direct || nested;
      }

      sibling = sibling.nextElementSibling;
    }

    return null;
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
    return Boolean(value && value.length >= 2 && value.length <= 120 && !/linkedin/i.test(value));
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
    _internals: {
      cleanCompany,
      cleanTitle,
      readRichText,
      unwrapLinkedInRedirect
    }
  };
})();
