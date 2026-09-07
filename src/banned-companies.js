(function registerBannedCompanies(root) {
  "use strict";

  const STORAGE_KEY = "kaiFlowBannedCompaniesV1";
  const MAX_COMPANIES = 500;
  const MAX_NAME_CHARS = 200;

  function normalize(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function key(value) {
    return normalize(value).toLocaleLowerCase("en-US");
  }

  function sanitize(values) {
    if (!Array.isArray(values)) throw new Error("The banned-company list must be an array.");
    const names = [];
    const seen = new Set();
    for (const value of values) {
      const name = normalize(value);
      const normalized = key(name);
      if (!name || seen.has(normalized)) continue;
      if (name.length > MAX_NAME_CHARS) throw new Error(`Company names must be ${MAX_NAME_CHARS} characters or shorter.`);
      seen.add(normalized);
      names.push(name);
      if (names.length > MAX_COMPANIES) throw new Error(`Keep the banned-company list under ${MAX_COMPANIES} companies.`);
    }
    return names.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  }

  function parse(text) {
    const source = String(text || "").trim();
    if (!source) return [];
    if (source.startsWith("[")) {
      let parsed;
      try { parsed = JSON.parse(source); } catch { throw new Error("The imported JSON list is invalid."); }
      return sanitize(parsed);
    }
    return sanitize(source.split(/\r?\n|,/u));
  }

  function create(storage = root.chrome?.storage?.sync) {
    async function init() {
      if (!storage) throw new Error("Synced extension storage is unavailable.");
      await storage.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
    }
    async function list() {
      await init();
      const saved = (await storage.get(STORAGE_KEY))?.[STORAGE_KEY];
      return sanitize(Array.isArray(saved) ? saved : []);
    }
    async function set(values) {
      await init();
      const companies = sanitize(values);
      await storage.set({ [STORAGE_KEY]: companies });
      return companies;
    }
    async function has(company) {
      const normalized = key(company);
      return normalized ? (await list()).some((name) => key(name) === normalized) : false;
    }
    return Object.freeze({ list, set, has });
  }

  root.KaiFlowBannedCompanies = Object.freeze({ create, normalize, key, sanitize, parse, STORAGE_KEY });
})(globalThis);
