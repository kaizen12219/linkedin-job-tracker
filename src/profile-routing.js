(function exposeProfileRouting(root) {
  "use strict";
  const VERSION = 1;
  const AUTOMATIC = "__automatic_profile__";
  const text = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
  const key = (value) => text(value).toLowerCase().replace(/[^a-z0-9]/gu, "");
  const GEO_REGIONS = Object.freeze({ "100876405": "colombia", "101165590": "uk", "103644278": "us" });
  const ALIASES = Object.freeze({
    jose: ["joseibero2page", "joseibero1page", "joseibero", "jose"], michal: ["michalstefanow2page", "michalstefanow1page", "michalstefanow", "michal"],
    kevin: ["kevinlee2page", "kevinlee1page", "kevinlee", "kevin"], jagjeet: ["jagjeetwani2page", "jagjeetwani1page", "jagjeetwani", "jagjeet"]
  });
  const NAMES = Object.freeze({ jose: "Jose Ibero", michal: "Michal Stefanow", kevin: "Kevin Lee", jagjeet: "Jagjeet Wani" });
  function region(value) {
    const normalized = key(text(value).normalize("NFD").replace(/[\u0300-\u036f]/gu, ""));
    if (["colombia"].includes(normalized)) return "colombia";
    if (["latam", "latinamerica", "latinamericaandthecaribbean", "americalatina", "latinoamerica"].includes(normalized)) return "latam";
    if (["uk", "gb", "unitedkingdom", "greatbritain", "reinounido"].includes(normalized)) return "uk";
    if (["us", "usa", "unitedstates", "unitedstatesofamerica", "estadosunidos"].includes(normalized)) return "us";
    return "";
  }
  function regionFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) || !url.pathname.startsWith("/jobs")) return "";
      const ids = [...new Set(url.searchParams.getAll("geoId").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
      if (ids.length > 1) return "";
      if (ids.length === 1 && GEO_REGIONS[ids[0]]) return GEO_REGIONS[ids[0]];
      return region(url.searchParams.get("location"));
    } catch { return ""; }
  }
  function selectedSearchRegion(doc, sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (url.protocol !== "https:" || !(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) || !url.pathname.startsWith("/jobs")) return { region: "", source: "" };
      const ids = [...new Set(url.searchParams.getAll("geoId").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
      if (ids.length > 1) return { region: "", source: "url" };
      const fromUrl = regionFromUrl(sourceUrl);
      if (!/\/jobs\/(?:search|search-results)/u.test(url.pathname)) return { region: fromUrl, source: fromUrl ? "url" : "" };
      const countries = new Set();
      let locationControl = false;
      // The search header's country button is committed state. Exclude the
      // selected job, result cards and options in an open location menu.
      for (const node of doc.querySelectorAll?.("button, [role='button'], [role='combobox']") || []) {
        if (["INPUT", "TEXTAREA"].includes(node.tagName) || node.closest?.("[hidden], [aria-hidden='true'], [inert], [role='menu'], [role='listbox'], [role='dialog'], .jobs-details, .jobs-details__main-content, .job-view-layout, .jobs-search__job-details--container, [data-job-id], [componentkey='JobDetails_AboutTheJob'], [data-occludable-job-id], .job-card-container, [data-view-name='job-card'], [componentkey^='job-card-component-ref-']")) continue;
        const style = doc.defaultView?.getComputedStyle?.(node);
        if (style?.display === "none" || style?.visibility === "hidden") continue;
        const label = text(node.getAttribute?.("aria-label"));
        const content = text(node.textContent);
        const strip = (value) => value.replace(/^(?:(?:filter|search)\s+(?:by|in)\s+|(?:change|select)\s+)?(?:location|country)\s*[:,-]?\s*/iu, "").replace(/^search\s+in\s+/iu, "");
        const country = region(strip(content)) || region(strip(label));
        if (country) countries.add(country);
        if (country || (/^(?:(?:filter|search)\s+(?:by|in)\s+|(?:change|select)\s+)?(?:location|country)\b/iu.test(label) && (strip(label) || strip(content)))) locationControl = true;
      }
      if (locationControl) return { region: countries.size === 1 ? [...countries][0] : "", source: "search-control" };
      if (fromUrl) return { region: fromUrl, source: "url" };
      const input = doc.querySelector("#jobs-search-box-location-id, input[id*='jobs-search-box-location'], input.jobs-search-box__text-input[aria-label*='location' i], [data-test-search-bar-location-input]");
      return { region: region(input?.value), source: input ? "search-input" : "" };
    } catch { return { region: "", source: "" }; }
  }
  function selectedRegion(doc, sourceUrl) { return selectedSearchRegion(doc, sourceUrl).region; }
  function jobRegion(job) {
    try {
      if ([...new Set(new URL(job?.sourceUrl).searchParams.getAll("geoId").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))].length > 1) return "";
    } catch { /* Captured region also supports jobs without a search URL. */ }
    if (job?.selectedRegionSource === "search-control") return region(job?.selectedRegion);
    return regionFromUrl(job?.sourceUrl) || region(job?.selectedRegion);
  }
  function failure(code, message) { return Object.assign(new Error(message), { code }); }
  function resolveProfile(candidate, options = {}) {
    const profiles = [...new Set((options.profiles || []).filter((p) => typeof p === "string" && p.trim()))];
    // Prefer the current two-page id; older saved job IDs remain compatible.
    const canonical = profiles.filter((p) => key(p) === ALIASES[candidate][0]);
    if (canonical.length === 1) return canonical[0];
    const legacy = profiles.filter((p) => key(p) === ALIASES[candidate][1]);
    if (legacy.length === 1) return legacy[0];
    const matches = profiles.filter((p) => ALIASES[candidate].includes(key(p)) || ALIASES[candidate].includes(key(options.profileLabels?.[p])));
    if (matches.length !== 1) throw failure("PROFILE_ROUTING_UNAVAILABLE", `${NAMES[candidate]} ${matches.length ? "has more than one matching profile" : "is unavailable"} in Kai Flow. Check the profile settings before saving.`);
    return matches[0];
  }
  function snapshot(job, options) {
    const selected = jobRegion(job);
    if (!selected) return null;
    const candidates = selected === "us" ? ["kevin", "jagjeet"] : [selected === "uk" ? "michal" : "jose"];
    const profiles = Object.fromEntries(candidates.map((candidate) => [candidate, resolveProfile(candidate, options)]));
    return { version: VERSION, region: selected, profiles };
  }
  const SENIOR_TITLE = /\b(?:senior|sr\.?|staff|principal|architect)\b/iu;
  const YEAR_WORDS = Object.freeze({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 });
  function quotedYears(evidence) {
    const number = String.raw`(?:\d+(?:\.\d+)?|${Object.keys(YEAR_WORDS).join("|")})`;
    const parenthetical = String.raw`(?:\s*\(\s*\d+\s*\))?`;
    const pattern = new RegExp(String.raw`\b(${number})${parenthetical}(?:\s*[-–—�]\s*${number}${parenthetical}|\s+to\s+${number}${parenthetical})?(?:\s*\+|\s+or\s+more)?\s*(?:years?|yrs?)\b`, "giu");
    return [...text(evidence).matchAll(pattern)].map((match) => YEAR_WORDS[match[1].toLowerCase()] ?? Number(match[1]));
  }
  function verifiedExperience(job, value) {
    if (!value || !Object.prototype.hasOwnProperty.call(value, "minimumYears")) return false;
    const years = value.minimumYears;
    const evidence = text(value.evidence);
    const quote = evidence.length >= 24 && evidence.length <= 2000 && text(job?.description).toLowerCase().includes(evidence.toLowerCase());
    if (years !== null) return typeof years === "number" && Number.isFinite(years) && years >= 0 && years <= 50 && quote && quotedYears(evidence).includes(years);
    return ["senior", "ordinary"].includes(value.scope) && quote;
  }
  function choose(job, routing, experience) {
    if (!routing || routing.version !== VERSION) return null;
    let candidate;
    if (routing.region === "us") {
      if (!verifiedExperience(job, experience)) throw failure("PROFILE_ROUTING_UNCONFIRMED", "US experience requirements could not be confirmed. This job has not been saved.");
      candidate = experience.minimumYears !== null ? (experience.minimumYears >= 5 ? "kevin" : "jagjeet")
        : SENIOR_TITLE.test(text(job.title)) || experience.scope === "senior" ? "kevin" : "jagjeet";
    } else candidate = routing.region === "uk" ? "michal" : ["colombia", "latam"].includes(routing.region) ? "jose" : null;
    if (!candidate || !routing.profiles?.[candidate]) throw failure("PROFILE_ROUTING_UNAVAILABLE", "The automatic profile is unavailable. This job has not been saved.");
    return { profile: routing.profiles[candidate], candidate, label: NAMES[candidate], reason: routing.region !== "us" ? `Selected region: ${routing.region}.`
      : experience.minimumYears !== null ? `Required engineering experience: ${experience.minimumYears}+ years.` : "No clear required years; used the role's seniority." };
  }
  const api = Object.freeze({ VERSION, AUTOMATIC, region, regionFromUrl, selectedSearchRegion, selectedRegion, jobRegion, snapshot, choose, verifiedExperience });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.JobProfileRouting = api;
})(typeof globalThis === "undefined" ? this : globalThis);
