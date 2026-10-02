(function exposeCapturePolicy(root) {
  "use strict";
  const text = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
  const key = (value) => text(value).toLocaleLowerCase("en-US");
  const ROLE_CATEGORIES = Object.freeze(["software-development", "web-development", "mobile-development",
    "infrastructure-engineering", "data-ai-engineering", "test-automation"]);
  // Title keywords can only reject clear exclusions. They never approve a job.
  const EXCLUDED_TITLE = /\b(?:business\s+(?:systems?\s+)?analyst|data\s+analyst|(?:product|project|program(?:me)?)\s+manager|scrum\s+master|recruiter|recruitment\s+(?:consultant|manager|coordinator)|talent\s+acquisition|sales\s+(?:representative|executive|manager)|account\s+executive|business\s+development\s+(?:representative|manager)|(?:it|desktop|technical)\s+support|help\s*desk|service\s+desk|manual\s+(?:qa|test(?:er|ing)?))\b/iu;
  function roleSkipReason(job) {
    return EXCLUDED_TITLE.test(text(job?.title ?? job?.jobTitle)) ? "Skipped: role is outside software engineering." : "";
  }
  function verifiedRole(job, result) {
    const role = result?.role;
    const evidence = text(role?.evidence);
    return !roleSkipReason(job) && role?.eligible === true && ROLE_CATEGORIES.includes(role.category) &&
      evidence.length >= 24 && evidence.length <= 2000 && key(job?.description ?? job?.jobDescription).includes(key(evidence));
  }
  function linkedInUrl(value) {
    try {
      const url = new URL(value);
      return url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
    } catch { return false; }
  }
  function publicUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password ||
        (url.port && url.port !== "443") || linkedInUrl(url.href) ||
        !url.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/iu.test(url.hostname) ||
        /^[\d.]+$/u.test(url.hostname) || url.hostname.includes(":")) return "";
      // Reject wrappers carrying a LinkedIn destination, including encoded ones.
      for (const value of url.searchParams.values()) {
        let decoded = value;
        for (let depth = 0; depth < 3; depth++) {
          if (linkedInUrl(decoded)) return "";
          try { decoded = decodeURIComponent(decoded); } catch { break; }
        }
      }
      return url.href;
    } catch { return ""; }
  }
  function needsRemoteCheck(job) {
    // Missing or unfamiliar labels must never bypass the remote-work gate.
    return key(job?.workplaceType) !== "remote";
  }
  const FULLY_REMOTE = /\b(?:fully|completely|entirely|exclusively|permanently)\s*[-–—]?\s*remote\b|\b100\s*%\s*[-–—]?\s*remote\b|\bremote[- ]only\b|\b(?:work|working)\s+from\s+anywhere\b|\bfull[- ]time\s+remote\b|\bremote\s+(?:on\s+)?a\s+full[- ]time\s+basis\b/iu;
  function requiredOfficeAttendance(description) {
    return String(description ?? "").split(/\n|(?<=[.!?])\s+/u).some((line) => {
      // Remove explicit optional/negated attendance statements before looking
      // for a conflicting obligation elsewhere in the description.
      const value = key(line)
        .replace(/\b(?:no|without)\s+(?:(?:mandatory|required|regular|any)\s+)*(?:office|on[- ]site|in[- ]person)\s+(?:attendance|work|presence|visits?)\b/gu, "")
        .replace(/\b(?:office|on[- ]site|in[- ]person)\s+(?:attendance|work|presence|visits?)\s+(?:is\s+|are\s+)?(?:not\s+required|optional)\b/gu, "");
      return /\b(?:must|required|mandatory|expected|need(?:s)?\s+to|have\s+to)\b.{0,80}\b(?:office|on[- ]site|onsite|in[- ]person)\b|\b(?:office|on[- ]site|onsite|in[- ]person)\s+(?:attendance|work|presence|visits?)\b.{0,40}\b(?:required|mandatory|expected)\b|\b(?:office|on[- ]site|onsite)\b.{0,40}\b(?:\d+|one|two|three|four|five|once|twice)\s+(?:days?|times?)\s+(?:a|per|each|every)\s+(?:week|month)\b|\b(?:\d+|one|two|three|four|five)\s+days?\b.{0,30}\b(?:in\s+(?:the\s+)?office|on[- ]site|onsite)\b/iu.test(value);
    });
  }
  function hasFullyRemoteOffer(description) {
    if (requiredOfficeAttendance(description)) return false;
    return String(description ?? "").split(/\n|(?<=[.!?])\s+/u).some((line) => {
      const value = key(line);
      const match = FULLY_REMOTE.exec(value);
      if (!match) return false;
      const before = value.slice(0, match.index);
      const after = value.slice(match.index + match[0].length);
      if (/\b(?:not|never|cannot|can't|isn't|aren't|won't|may|might|could|potentially|possibly|eventually|future)\b.{0,60}$/iu.test(before) ||
        /\bno\s+(?:option\s+for\s+)?$/iu.test(before) ||
        /^.{0,30}\b(?:unavailable|not\s+(?:available|possible|offered|supported|permitted|allowed)|only\s+(?:after|if)|in\s+(?:the\s+)?future)\b/iu.test(after)) return false;
      // Benefits for other employees and future/conditional arrangements do
      // not establish a fully remote option for the captured role.
      if (/\b(?:equipment|allowance|stipend|benefits?)\b.{0,40}\bfor\b.{0,40}\bremote\b|\b(?:other|some)\s+(?:roles?|employees?)\b|\bremote\s+(?:employees|colleagues|staff|workers)\b/iu.test(value) ||
        /\b(?:may|might|could|potentially|possibly|eventually|future|subject\s+to\s+approval)\b/iu.test(value)) return false;
      return true;
    });
  }
  function remoteSkipReason(job) {
    return needsRemoteCheck(job) && !hasFullyRemoteOffer(job?.description ?? job?.jobDescription)
      ? "The job description does not explicitly offer fully remote work without required office attendance. Nothing was added."
      : "";
  }
  function needsResearch(job) { return !roleSkipReason(job); }
  function validEmail(value) {
    const email = text(value);
    return email.length <= 254 && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/iu.test(email) &&
      !/^(?:no[-_.]?reply|privacy|dpo|legal|support|unsubscribe)@/iu.test(email) ? email : "";
  }
  function verifiedJob(job, result) {
    if (!result || result.decision !== "save") return null;
    if (key(result.company) !== key(job.company) || key(result.title) !== key(job.title ?? job.jobTitle)) return null;
    if (!verifiedRole(job, result)) return null;
    if (job.applicationsClosed === true) return null;
    if (remoteSkipReason(job)) return null;
    if (needsRemoteCheck(job) && (result.fullyRemote !== true ||
      text(result.remoteEvidence).length < 8 || !hasFullyRemoteOffer(result.remoteEvidence) ||
      !key(job.description ?? job.jobDescription).includes(key(result.remoteEvidence)))) return null;
    const output = { ...job };
    const findings = [];
    const emails = [];
    for (const item of Array.isArray(result.emails) ? result.emails.slice(0, 5) : []) {
      const email = validEmail(item.email);
      if (!email || !["application", "poster"].includes(item.kind) ||
        key(item.company) !== key(job.company) || text(item.sourceQuote).length < 8 ||
        !key(item.sourceQuote).includes(key(email))) continue;
      const fromDescription = item.source === "description" &&
        key(job.description ?? job.jobDescription).includes(key(item.sourceQuote));
      const fromPublicPage = item.source === "public" && publicUrl(item.sourceUrl);
      if (!fromDescription && !fromPublicPage) continue;
      if (item.kind === "poster" && (!text(job.posterName) || key(item.posterName) !== key(job.posterName))) continue;
      if (emails.some((entry) => key(entry.email) === key(email))) continue;
      emails.push({ ...item, email });
    }
    const application = result.application;
    const originalUrl = publicUrl(application?.url);
    const candidateUrl = publicUrl(application?.finalUrl || application?.url);
    const sameApplicationPage = (value) => {
      const url = publicUrl(value).split("#")[0];
      return !!url && [originalUrl, candidateUrl].some((page) => page && page.split("#")[0] === url);
    };
    let externalUrl = "";
    if (application && originalUrl && candidateUrl && application.applicationsOpen === true && application.free === true &&
      key(application.company) === key(job.company) && text(application.evidence).length >= 8) {
      const route = application.route || "web";
      const exactTitle = key(application.title) === key(job.title ?? job.jobTitle);
      // An email source is promoted only when research explicitly verifies an
      // open job-specific application page and the same vacancy's description.
      const emailPage = route === "email" && text(application.title) && text(application.descriptionEvidence).length >= 100 &&
        key(job.description ?? job.jobDescription).includes(key(application.descriptionEvidence)) &&
        emails.some((item) => item.kind === "application" && item.source === "public" &&
          sameApplicationPage(item.sourceUrl) && key(application.evidence).includes(key(item.email)));
      if ((route === "web" && exactTitle) || emailPage) externalUrl = candidateUrl;
    }
    if (externalUrl) {
      output.applyUrl = externalUrl;
      const linkedInSource = [job.sourceUrl, job.applyUrl].find((value) => linkedInUrl(value));
      if (linkedInSource && !text(job.info).includes(linkedInSource)) findings.push(`LinkedIn job: ${linkedInSource}`);
    }
    for (const item of emails) {
      const source = item.source === "description" ? "job description" :
        externalUrl && sameApplicationPage(item.sourceUrl) ? "" : item.sourceUrl;
      findings.push(`${item.kind === "poster" ? "Job poster" : "Application"} email: ${item.email}${source ? ` (${source})` : ""}`);
    }
    if (job.isEasyApply === true && !externalUrl && !emails.length) return null;
    if (needsRemoteCheck(job)) findings.unshift(`Fully remote confirmed: ${text(result.remoteEvidence)}`);
    output.info = [text(job.info), ...findings].filter(Boolean).join(" | ").slice(0, 49000);
    // An email-only Easy Apply result keeps the current job URL for reference.
    if (!output.applyUrl && job.isEasyApply === true) output.applyUrl = job.sourceUrl || "";
    return output;
  }
  const api = Object.freeze({ text, key, ROLE_CATEGORIES, roleSkipReason, verifiedRole, linkedInUrl, publicUrl, needsRemoteCheck, hasFullyRemoteOffer, remoteSkipReason, needsResearch, validEmail, verifiedJob });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.JobCapturePolicy = api;
})(typeof globalThis === "undefined" ? this : globalThis);
