const scrapeButton = document.querySelector("#scrape");
const copyJsonButton = document.querySelector("#copyJson");
const saveButton = document.querySelector("#saveSheet");
const openApplyUrlLink = document.querySelector("#openApplyUrl");
const refreshButton = document.querySelector("#refreshConnection");
const profileSelect = document.querySelector("#profile");
const connectionEl = document.querySelector("#connectionStatus");
const statusEl = document.querySelector("#status");
const duplicateEl = document.querySelector("#duplicate");
const jsonEl = document.querySelector("#json");
const sheetSettings = document.querySelector("#sheetSettings");
const credentialsFile = document.querySelector("#credentialsFile");
const credentialsStatus = document.querySelector("#credentialsStatus");
const sheetUrlInput = document.querySelector("#sheetUrl");
const sheetGidInput = document.querySelector("#sheetGid");
const saveSettingsButton = document.querySelector("#saveSheetSettings");
const removeSettingsButton = document.querySelector("#removeSheetSettings");
const bannedInput = document.querySelector("#bannedCompanies");
const bannedStatus = document.querySelector("#bannedStatus");
const saveBannedButton = document.querySelector("#saveBanned");
const exportBannedButton = document.querySelector("#exportBanned");
const importBannedInput = document.querySelector("#importBanned");
const fields = Object.fromEntries(["title", "company", "applyUrl", "description"]
  .map((name) => [name, document.querySelector(`#${name}`)]));
const PROFILE_KEY = "kaiFlowSelectedProfile";
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

let latestPayload = null;
let profiles = [];
let connected = false;
let configured = false;
let scraping = false;
let saving = false;
let duplicate = null;
let bannedCompanies = [];
let lookupVersion = 0;
let optionsVersion = 0;
let connectionState = "unconfigured";
let selectedCredentials = null;
let duplicateTimer;

document.addEventListener("DOMContentLoaded", () => {
  void loadBannedCompanies();
  void loadOptions();
  void scrapeCurrentTab();
});

chrome.runtime.onMessage?.addListener((message, sender) => {
  if (sender?.id === chrome.runtime.id && message?.type === "KAI_TRACKER_PROFILES_CHANGED") void loadOptions(true);
});

scrapeButton.addEventListener("click", () => void scrapeCurrentTab());
refreshButton.addEventListener("click", () => void loadOptions(true));

credentialsFile.addEventListener("change", async () => {
  const file = credentialsFile.files?.[0];
  selectedCredentials = null;
  if (!file) {
    credentialsStatus.textContent = configured
      ? "Stored credentials are unchanged. Choose a file only to replace them."
      : "Choose the service-account JSON file.";
    return;
  }
  try {
    if (file.size > MAX_CREDENTIAL_FILE_BYTES) throw new Error("The credentials file is unexpectedly large.");
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The credentials file must contain one JSON object.");
    selectedCredentials = parsed;
    credentialsStatus.textContent = `Selected ${file.name}. The private key will be stored only in this browser profile.`;
  } catch (error) {
    credentialsFile.value = "";
    credentialsStatus.textContent = error instanceof SyntaxError ? "The selected file is not valid JSON." : error.message;
  }
});

saveSettingsButton.addEventListener("click", async () => {
  if (!selectedCredentials && !configured) {
    setStatus("Choose the service-account credentials JSON file first.");
    return;
  }
  saveSettingsButton.disabled = true;
  removeSettingsButton.disabled = true;
  setStatus("Checking Google Sheet access…");
  try {
    const result = await request({
      type: "KAI_TRACKER_CONFIGURE",
      ...(selectedCredentials ? { credentials: selectedCredentials } : {}),
      sheetUrl: sheetUrlInput.value,
      sheetGid: sheetGidInput.value
    });
    selectedCredentials = null;
    credentialsFile.value = "";
    renderSheetStatus(result);
    sheetSettings.open = false;
    credentialsStatus.textContent = "Credentials are stored locally. Choose a file only to replace them.";
    setStatus(`Connected to ${result.sheetTitle || "the Google Sheet"}.`);
    await loadOptions(true);
  } catch (error) {
    setStatus(error.message);
    renderConnectionFailure(error);
  } finally {
    saveSettingsButton.disabled = false;
    removeSettingsButton.disabled = false;
  }
});

removeSettingsButton.addEventListener("click", async () => {
  if (!confirm("Remove the saved Google Sheet and service-account credentials from this browser profile?")) return;
  saveSettingsButton.disabled = true;
  removeSettingsButton.disabled = true;
  try {
    const result = await request({ type: "KAI_TRACKER_CLEAR_CONFIG" });
    selectedCredentials = null;
    credentialsFile.value = "";
    sheetUrlInput.value = "";
    sheetGidInput.value = "";
    renderSheetStatus(result);
    sheetSettings.open = true;
    credentialsStatus.textContent = "Choose the service-account JSON file.";
    applyProfiles({ profiles: [] }, "");
    setStatus("Google Sheet settings removed from this browser profile.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    saveSettingsButton.disabled = false;
    removeSettingsButton.disabled = false;
  }
});

for (const [name, input] of Object.entries(fields)) input.addEventListener("input", () => {
  latestPayload = { ...(latestPayload || {}), [name]: input.value };
  if (name === "company") {
    ++lookupVersion;
    renderDuplicate(null);
    clearTimeout(duplicateTimer);
    duplicateTimer = setTimeout(() => void checkDuplicate(), 350);
  }
  if (name === "applyUrl") {
    const url = safeWebUrl(input.value);
    openApplyUrlLink.href = url || "#";
    openApplyUrlLink.classList.toggle("disabled", !url);
  }
  renderJson();
  updateControls();
});

profileSelect.addEventListener("change", async () => {
  try {
    await chrome.storage.local.set({ [PROFILE_KEY]: profileSelect.value });
    setStatus(profileSelect.value ? `Profile: ${profileSelect.value}.` : "No profile selected. You can assign one later in Kai Sheet.");
  } catch {
    setStatus("Could not remember the profile for the shortcut. This save will still use your selection.");
  }
  renderJson();
  updateControls();
});

copyJsonButton.addEventListener("click", async () => {
  if (!latestPayload) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify({ ...latestPayload, profile: profileSelect.value }, null, 2));
    setStatus("Copied JSON.");
  } catch {
    setStatus("Could not copy. You can select the text under Raw JSON.");
  }
});

openApplyUrlLink.addEventListener("click", (event) => {
  if (openApplyUrlLink.classList.contains("disabled")) event.preventDefault();
});

saveButton.addEventListener("click", async () => {
  if (saving || scraping || !latestPayload || !canSave() || !validProfile() || duplicate || isCurrentCompanyBanned()) return;
  saving = true;
  updateControls();
  setStatus("Saving to Google Sheet…");
  try {
    const result = await request({ type: "KAI_TRACKER_SAVE", job: latestPayload, profile: profileSelect.value });
    setStatus(result.replayed
      ? "This exact job was already saved. No duplicate was created."
      : "Saved to Google Sheet · Pending.");
    void checkDuplicate();
  } catch (error) {
    if (error.code === "DUPLICATE_COMPANY" && error.details?.duplicate) {
      renderDuplicate(error.details.duplicate);
      setStatus("This company already has a recorded job. Nothing was added.");
    } else if (error.code === "BANNED_COMPANY") {
      renderDuplicate(null);
      setStatus(error.message);
    } else {
      setStatus(error.message);
      if (/UNAVAILABLE|OFFLINE|UNCONFIRMED|TIMEOUT/.test(error.code || "")) {
        connected = false;
        connectionState = "offline";
        connectionEl.textContent = "Google Sheets unavailable · nothing queued";
      }
    }
  } finally {
    saving = false;
    updateControls();
  }
});

saveBannedButton.addEventListener("click", () => {
  try { void saveBannedCompanies(parseCompanyList(bannedInput.value)); }
  catch (error) { setBannedStatus(error.message); }
});

exportBannedButton.addEventListener("click", () => {
  const blob = new Blob([`${bannedCompanies.join("\n")}${bannedCompanies.length ? "\n" : ""}`], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "kai-sheet-banned-companies.txt";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setBannedStatus(`Exported ${bannedCompanies.length} ${bannedCompanies.length === 1 ? "company" : "companies"}.`);
});

importBannedInput.addEventListener("change", async () => {
  const file = importBannedInput.files?.[0];
  if (!file) return;
  try {
    await saveBannedCompanies(parseCompanyList(await file.text()));
    setBannedStatus(`Imported ${bannedCompanies.length} ${bannedCompanies.length === 1 ? "company" : "companies"}.`);
  } catch (error) {
    setBannedStatus(error.message);
  } finally {
    importBannedInput.value = "";
  }
});

async function request(message) {
  let response;
  try { response = await chrome.runtime.sendMessage(message); }
  catch {
    const uncertain = message.type === "KAI_TRACKER_SAVE";
    const error = new Error(uncertain
      ? "The save result could not be confirmed. Nothing will retry automatically; check the Google Sheet before saving this company again."
      : "The tracker could not confirm the request. Reload the extension and try again.");
    error.code = uncertain ? "TRACKER_SAVE_UNCONFIRMED" : "TRACKER_UNAVAILABLE";
    throw error;
  }
  if (!response?.ok) {
    const error = new Error(response?.error?.message || "The tracker could not complete this request.");
    error.code = response?.error?.code || "TRACKER_UNAVAILABLE";
    error.details = response?.error?.details;
    throw error;
  }
  return response.result;
}

async function loadOptions(refresh = false) {
  const version = ++optionsVersion;
  refreshButton.disabled = true;
  connectionEl.textContent = "Checking Google Sheet…";
  try {
    const currentStatus = await request({ type: "KAI_TRACKER_STATUS" });
    if (version !== optionsVersion) return;
    renderSheetStatus(currentStatus);
    if (!configured) {
      sheetSettings.open = true;
      return;
    }
    const saved = await chrome.storage.local.get(PROFILE_KEY);
    if (version !== optionsVersion) return;
    const selected = typeof saved[PROFILE_KEY] === "string" ? saved[PROFILE_KEY] : "";
    applyProfiles(currentStatus.profileOptions || { profiles: [] }, selected);
    const result = await request({ type: "KAI_TRACKER_OPTIONS", refresh });
    if (version !== optionsVersion) return;
    applyProfiles(result, selected);
    connected = true;
    connectionState = "connected";
    connectionEl.textContent = `Connected · ${currentStatus.sheetTitle || "Google Sheet"}`;
    renderJson();
    void checkDuplicate();
  } catch (error) {
    if (version !== optionsVersion) return;
    renderConnectionFailure(error);
    setStatus(error.message);
  } finally {
    if (version === optionsVersion) {
      refreshButton.disabled = false;
      updateControls();
    }
  }
}

function renderConnectionFailure(error) {
  connected = false;
  const code = String(error?.code || "");
  if (/CONFIG_REQUIRED/.test(code)) {
    configured = false;
    connectionState = "unconfigured";
    connectionEl.textContent = "Google Sheet not configured";
    sheetSettings.open = true;
  } else if (/AUTH|FORBIDDEN|NOT_FOUND|SCHEMA|INVALID_SERVICE_ACCOUNT|INVALID_SHEET/.test(code)) {
    connectionState = "invalid";
    connectionEl.textContent = "Google Sheet settings need attention";
    sheetSettings.open = true;
  } else {
    connectionState = "offline";
    connectionEl.textContent = "Google Sheets unavailable · nothing queued";
  }
  updateControls();
}

function applyProfiles(result, selected) {
  profiles = [...new Set((result.profiles || []).filter((value) => typeof value === "string" && value.trim()))];
  profileSelect.replaceChildren(new Option("No profile", ""));
  for (const profile of profiles) profileSelect.append(new Option(result.profileLabels?.[profile] || profile, profile));
  if (selected && !profiles.includes(selected)) {
    profileSelect.append(new Option(`${selected} — unavailable`, selected));
    setStatus("Your saved profile is unavailable. Select a valid profile or No profile before saving.");
  }
  profileSelect.value = selected;
  renderJson();
}

function renderSheetStatus(status) {
  configured = Boolean(status.configured);
  connectionState = status.connection || (configured ? "checking" : "unconfigured");
  connected = connectionState === "connected";
  if (status.sheetUrl) sheetUrlInput.value = status.sheetUrl;
  if (status.sheetGid !== undefined && status.sheetGid !== "") sheetGidInput.value = String(status.sheetGid);
  credentialsStatus.textContent = configured
    ? "Credentials are stored locally. Choose a file only to replace them."
    : "Choose the service-account JSON file.";
  removeSettingsButton.disabled = false;
  connectionEl.textContent = !configured
    ? "Google Sheet not configured"
    : connected
      ? `Connected · ${status.sheetTitle || "Google Sheet"}`
      : connectionState === "invalid"
        ? "Google Sheet settings need attention"
        : connectionState === "offline"
          ? "Google Sheets unavailable · nothing queued"
          : "Checking Google Sheet…";
  updateControls();
}

async function loadBannedCompanies() {
  try {
    const result = await request({ type: "KAI_TRACKER_BANNED_GET" });
    bannedCompanies = normalizeCompanyList(result.companies || []);
    bannedInput.value = bannedCompanies.join("\n");
    setBannedStatus(`${bannedCompanies.length} ${bannedCompanies.length === 1 ? "company" : "companies"} banned. Chrome sync and export are available.`);
    renderDuplicate(duplicate);
  } catch (error) {
    setBannedStatus(error.message);
  }
}

async function saveBannedCompanies(companies) {
  saveBannedButton.disabled = true;
  try {
    const result = await request({ type: "KAI_TRACKER_BANNED_SET", companies });
    bannedCompanies = normalizeCompanyList(result.companies || []);
    bannedInput.value = bannedCompanies.join("\n");
    setBannedStatus(`Saved ${bannedCompanies.length} ${bannedCompanies.length === 1 ? "company" : "companies"}. LinkedIn cards are updating.`);
    renderDuplicate(duplicate);
    void checkDuplicate();
  } catch (error) {
    setBannedStatus(error.message);
  } finally {
    saveBannedButton.disabled = false;
  }
}

async function scrapeCurrentTab() {
  if (scraping || saving) return;
  scraping = true;
  latestPayload = null;
  renderDuplicate(null);
  ++lookupVersion;
  setStatus("Reading the LinkedIn job…");
  updateControls();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isSupportedUrl(tab.url || "")) throw new Error("Open a LinkedIn job page before scraping.");
    let response;
    try { response = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_LINKEDIN_JOB" }); }
    catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/scraper.js", "src/content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_LINKEDIN_JOB" });
    }
    if (!response?.ok) throw new Error(response?.error || "The scraper did not return a job.");
    latestPayload = response.data;
    for (const name of Object.keys(fields)) fields[name].value = latestPayload[name] || "";
    const applyUrl = safeWebUrl(latestPayload.applyUrl);
    openApplyUrlLink.href = applyUrl || "#";
    openApplyUrlLink.classList.toggle("disabled", !applyUrl);
    renderJson();
    const missing = ["company", "title", "description"].filter((key) => !String(latestPayload[key] || "").trim());
    setStatus(missing.length
      ? `Missing ${missing.join(", ")}. Expand the full job on LinkedIn and scrape again.`
      : connected && !validProfile()
        ? "Your saved profile is unavailable. Select a valid profile or No profile before saving."
        : "Job captured. Profile is optional.");
    void checkDuplicate();
  } catch (error) {
    latestPayload = null;
    for (const field of Object.values(fields)) field.value = "";
    openApplyUrlLink.href = "#";
    openApplyUrlLink.classList.add("disabled");
    renderJson();
    setStatus(error.message);
  } finally {
    scraping = false;
    updateControls();
  }
}

async function checkDuplicate() {
  const version = ++lookupVersion;
  if (!latestPayload?.company) return;
  if (isCurrentCompanyBanned()) {
    renderDuplicate(null);
    return;
  }
  if (!connected) return;
  try {
    const result = await request({ type: "KAI_TRACKER_DUPLICATE", company: latestPayload.company });
    if (version === lookupVersion) renderDuplicate(result.duplicate || null);
  } catch {
    if (version === lookupVersion) renderDuplicate(null);
  }
}

function renderDuplicate(value) {
  duplicate = value;
  const banned = isCurrentCompanyBanned();
  duplicateEl.replaceChildren();
  duplicateEl.hidden = !value && !banned;
  if (banned) {
    const heading = document.createElement("strong");
    heading.textContent = "Banned company";
    const title = document.createElement("span");
    title.textContent = latestPayload?.company || fields.company.value;
    const status = document.createElement("span");
    status.textContent = "Blocked by tracker list";
    const preview = document.createElement("p");
    preview.textContent = "Remove this company from Banned companies before saving it.";
    duplicateEl.append(heading, title, status, preview);
  } else if (value) {
    const heading = document.createElement("strong");
    heading.textContent = "Already in Google Sheet";
    const title = document.createElement("span");
    title.textContent = `${value.company || ""} · ${value.jobTitle || "Existing job"}`;
    const status = document.createElement("span");
    status.textContent = value.status === "added" ? "Pending" : String(value.status || "");
    duplicateEl.append(heading, title, status);
    if (value.jobDescriptionPreview) {
      const preview = document.createElement("p");
      preview.textContent = String(value.jobDescriptionPreview);
      duplicateEl.append(preview);
    }
  }
  updateControls();
}

function normalizeCompany(value) {
  return String(value || "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

function companyKey(value) {
  return normalizeCompany(value).toLocaleLowerCase("en-US");
}

function normalizeCompanyList(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(normalizeCompany).filter((name) => {
    const key = companyKey(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function parseCompanyList(text) {
  const source = String(text || "").trim();
  if (!source) return [];
  if (source.startsWith("[")) {
    let parsed;
    try { parsed = JSON.parse(source); } catch { throw new Error("The imported JSON list is invalid."); }
    if (!Array.isArray(parsed)) throw new Error("The imported JSON must be a list of company names.");
    return normalizeCompanyList(parsed);
  }
  return normalizeCompanyList(source.split(/\r?\n|,/gu));
}

function isCurrentCompanyBanned() {
  const current = companyKey(latestPayload?.company || fields.company.value);
  return Boolean(current && bannedCompanies.some((company) => companyKey(company) === current));
}

function setBannedStatus(message) {
  bannedStatus.textContent = message;
}

function validProfile() {
  return !profileSelect.value || profiles.includes(profileSelect.value);
}

function canSave() {
  return configured && connected && connectionState === "connected";
}

function updateControls() {
  const complete = latestPayload && ["company", "title", "description"].every((key) => String(latestPayload[key] || "").trim());
  saveButton.disabled = !canSave() || !complete || !validProfile() || saving || scraping || Boolean(duplicate) || isCurrentCompanyBanned();
  saveButton.textContent = saving ? "Saving…" : "Save";
  profileSelect.disabled = !configured || saving;
  scrapeButton.disabled = scraping || saving;
  copyJsonButton.disabled = !latestPayload || saving;
}

function renderJson() {
  jsonEl.textContent = JSON.stringify(latestPayload ? { ...latestPayload, profile: profileSelect.value } : {}, null, 2);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function isSupportedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) &&
      url.pathname.startsWith("/jobs");
  } catch {
    return false;
  }
}
