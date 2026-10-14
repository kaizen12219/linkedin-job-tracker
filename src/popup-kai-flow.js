const scrapeButton = document.querySelector("#scrape");
const copyJsonButton = document.querySelector("#copyJson");
const saveButton = document.querySelector("#saveSheet");
const openApplyUrlLink = document.querySelector("#openApplyUrl");
const refreshButton = document.querySelector("#refreshConnection");
const profileSelect = document.querySelector("#profile");
const researchModelSelect = document.querySelector("#researchModel");
const researchEffortSelect = document.querySelector("#researchEffort");
const researchModelStatus = document.querySelector("#researchModelStatus");
const refreshResearchModelsButton = document.querySelector("#refreshResearchModels");
const startResearchButton = document.querySelector("#startResearch");
const connectionEl = document.querySelector("#connectionStatus");
const statusEl = document.querySelector("#status");
const duplicateEl = document.querySelector("#duplicate");
const jsonEl = document.querySelector("#json");
const bannedInput = document.querySelector("#bannedCompanies");
const bannedStatus = document.querySelector("#bannedStatus");
const saveBannedButton = document.querySelector("#saveBanned");
const exportBannedButton = document.querySelector("#exportBanned");
const importBannedInput = document.querySelector("#importBanned");
const fields = Object.fromEntries(["title", "company", "applyUrl", "description"]
  .map((name) => [name, document.querySelector(`#${name}`)]));
const PROFILE_KEY = "kaiFlowSelectedProfile";

let latestPayload = null;
let profiles = [];
let profileOptions = { profiles: [] };
let captureProfile = null;
let automaticProfileError = "";
let connected = false;
let configured = false;
let scraping = false;
let saving = false;
let duplicate = null;
let bannedCompanies = [];
let lookupVersion = 0;
let optionsVersion = 0;
let connectionState = "unconfigured";
let duplicateTimer;
let researchModelsVersion = 0;
let researchModelsLoaded = false;
let researchModelSaving = false;
let researchWorkerStarting = false;
let selectedResearchModel = "";
let selectedResearchEffort = "";
let researchModelCatalog = null;

document.addEventListener("DOMContentLoaded", () => {
  void loadBannedCompanies();
  void loadResearchModels();
  void loadOptions();
  void scrapeCurrentTab();
});

refreshResearchModelsButton.addEventListener("click", () => void loadResearchModels());
startResearchButton.addEventListener("click", () => void startResearchWorker());
researchModelSelect.addEventListener("change", async () => {
  if (researchModelSaving || researchWorkerStarting || !researchModelsLoaded) return;
  const model = researchModelSelect.value;
  await saveResearchPreference({ type: "KAI_TRACKER_RESEARCH_MODEL_SET", model }, "AI model and reasoning level");
});
researchEffortSelect.addEventListener("change", async () => {
  if (researchModelSaving || researchWorkerStarting || !researchModelsLoaded) return;
  const reasoningEffort = researchEffortSelect.value;
  await saveResearchPreference({ type: "KAI_TRACKER_RESEARCH_EFFORT_SET", reasoningEffort }, "Reasoning level");
});

async function saveResearchPreference(message, label) {
  researchModelSaving = true;
  ++researchModelsVersion;
  updateResearchControls();
  researchModelStatus.textContent = `Saving ${label.toLowerCase()}…`;
  try {
    const result = await request(message);
    selectedResearchModel = result.selectedModel;
    selectedResearchEffort = result.selectedReasoningEffort || "";
    researchModelStatus.textContent = `${label} saved for new job sessions.`;
  } catch (error) {
    researchModelStatus.textContent = error.message;
  } finally {
    renderResearchSelection();
    researchModelSaving = false;
    updateResearchControls();
  }
}

function selectedResearchModelMetadata() {
  return researchModelCatalog?.models.find(model => model.id === (selectedResearchModel || researchModelCatalog.defaultModel));
}

function availableResearchEfforts() {
  return selectedResearchModelMetadata()?.reasoningEfforts?.filter(value => typeof value === "string" && value) || [];
}

function effortLabel(effort) {
  const labels = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high (xhigh)", max: "Maximum (max)", ultra: "Ultra" };
  return Object.hasOwn(labels, effort) ? labels[effort] : effort.charAt(0).toUpperCase() + effort.slice(1);
}

function renderResearchSelection() {
  researchModelSelect.value = selectedResearchModel;
  const model = selectedResearchModelMetadata();
  const efforts = availableResearchEfforts();
  const researchDefault = researchModelCatalog?.defaultReasoningEffort;
  const automatic = efforts.includes(researchDefault) ? researchDefault : model?.defaultReasoningEffort;
  researchEffortSelect.replaceChildren(new Option(automatic && efforts.includes(automatic)
    ? `Automatic · ${effortLabel(automatic)}` : "Automatic", ""));
  for (const effort of efforts) researchEffortSelect.append(new Option(effortLabel(effort), effort));
  if (selectedResearchEffort && !efforts.includes(selectedResearchEffort)) {
    const option = new Option(`${effortLabel(selectedResearchEffort)} — unavailable`, selectedResearchEffort);
    option.disabled = true;
    researchEffortSelect.append(option);
  }
  researchEffortSelect.value = selectedResearchEffort;
}

function updateResearchControls() {
  const blocked = researchModelSaving || researchWorkerStarting;
  researchModelSelect.disabled = blocked || !researchModelsLoaded;
  researchEffortSelect.disabled = blocked || !researchModelsLoaded || (!availableResearchEfforts().length && !selectedResearchEffort);
  refreshResearchModelsButton.disabled = blocked;
  startResearchButton.disabled = blocked;
}

async function startResearchWorker() {
  if (researchWorkerStarting || researchModelSaving) return;
  researchWorkerStarting = true;
  ++researchModelsVersion;
  updateResearchControls();
  startResearchButton.textContent = "Starting…";
  researchModelStatus.textContent = "Starting the research worker…";
  try {
    await request({ type: "KAI_TRACKER_RESEARCH_START" });
    await loadResearchModels({ duringRecovery: true });
  } catch (error) {
    researchModelStatus.textContent = error.message;
  } finally {
    researchWorkerStarting = false;
    startResearchButton.textContent = "Start / reconnect research";
    renderResearchSelection();
    updateResearchControls();
  }
}

async function loadResearchModels({ duringRecovery = false } = {}) {
  if (researchModelSaving || (researchWorkerStarting && !duringRecovery)) return;
  const version = ++researchModelsVersion;
  researchModelSelect.disabled = true;
  researchEffortSelect.disabled = true;
  refreshResearchModelsButton.disabled = true;
  researchModelStatus.textContent = "Loading the signed-in session’s models…";
  try {
    const catalog = await request({ type: "KAI_TRACKER_RESEARCH_MODELS" });
    if (version !== researchModelsVersion) return;
    researchModelCatalog = catalog;
    selectedResearchModel = catalog.selectedModel;
    selectedResearchEffort = catalog.selectedReasoningEffort || "";
    const defaultName = catalog.models.find((model) => model.id === catalog.defaultModel)?.name || catalog.defaultModel;
    researchModelSelect.replaceChildren(new Option(`Session default · ${defaultName}`, ""));
    for (const model of catalog.models) researchModelSelect.append(new Option(model.name, model.id));
    const unavailable = selectedResearchModel && !catalog.models.some((model) => model.id === selectedResearchModel);
    if (unavailable) {
      const option = new Option(`${selectedResearchModel} — unavailable`, selectedResearchModel);
      option.disabled = true;
      researchModelSelect.append(option);
    }
    renderResearchSelection();
    researchModelsLoaded = true;
    const effortUnavailable = selectedResearchEffort && !availableResearchEfforts().includes(selectedResearchEffort);
    researchModelStatus.textContent = unavailable
      ? "Your saved model is unavailable. Choose another model for new sessions."
      : effortUnavailable ? "Your saved reasoning level is unavailable for this model. Choose another level for new sessions."
      : "Models reported by the signed-in session.";
  } catch (error) {
    if (version !== researchModelsVersion) return;
    researchModelsLoaded = false;
    researchModelStatus.textContent = error.message;
  } finally {
    if (version === researchModelsVersion) {
      updateResearchControls();
    }
  }
}

chrome.runtime.onMessage?.addListener((message, sender) => {
  if (sender?.id === chrome.runtime.id && message?.type === "KAI_TRACKER_PROFILES_CHANGED") void loadOptions(true);
  if (sender?.id === chrome.runtime.id && message?.type === "KAI_TRACKER_PROFILE_SELECTED" && latestPayload &&
    message.sourceUrl === latestPayload.sourceUrl && message.jobId === latestPayload.jobId && message.company === latestPayload.company &&
    message.title === latestPayload.title && message.description === latestPayload.description) {
    captureProfile = message.profile;
    applyProfiles(profileOptions, profileSelect.value);
    setStatus(`Profile: ${message.label}. ${message.reason}`);
    updateControls();
  }
});

scrapeButton.addEventListener("click", () => void scrapeCurrentTab());
refreshButton.addEventListener("click", () => void loadOptions(true));
document.querySelector("#folderSettings").addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL("folder.html") }));

for (const [name, input] of Object.entries(fields)) input.addEventListener("input", () => {
  latestPayload = { ...(latestPayload || {}), [name]: input.value };
  if (["title", "description"].includes(name)) {
    captureProfile = null;
    applyProfiles(profileOptions, profileSelect.value);
  }
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
  if (JobProfileRouting.jobRegion(latestPayload)) return;
  try {
    await chrome.storage.local.set({ [PROFILE_KEY]: profileSelect.value });
    setStatus(profileSelect.value ? `Profile: ${profileSelect.value}.` : "No profile selected. You can assign one later in ApplicantAlly.");
  } catch {
    setStatus("Could not remember the profile for the shortcut. This save will still use your selection.");
  }
  renderJson();
  updateControls();
});

copyJsonButton.addEventListener("click", async () => {
  if (!latestPayload) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify({ ...latestPayload, profile: selectedProfileValue() }, null, 2));
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
  setStatus("Saving to ApplicantAlly…");
  try {
    const result = await request({ type: "KAI_TRACKER_SAVE", job: latestPayload, profile: selectedProfileValue() });
    if (result.profile && result.profileRouting) { captureProfile = result.profile; applyProfiles(profileOptions, profileSelect.value); }
    setStatus(result.status === "researching" ? result.queued ? "Job queued for research. It will retry automatically when the local research worker is running."
      : "Research started in a desktop session. This job will be added only if it qualifies."
      : result.status === "skipped" ? result.reason : result.replayed
      ? "This exact job was already saved. No duplicate was created."
      : "Saved to ApplicantAlly · Pending.");
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
        connectionEl.textContent = "ApplicantAlly is unavailable";
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
      ? "The save result could not be confirmed. Nothing will retry automatically; check the ApplicantAlly before saving this company again."
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

async function loadOptions(refresh = true) {
  const version = ++optionsVersion;
  refreshButton.disabled = true;
  connectionEl.textContent = "Checking ApplicantAlly…";
  try {
    const currentStatus = await request({ type: "KAI_TRACKER_STATUS" });
    if (version !== optionsVersion) return;
    renderSheetStatus(currentStatus);
    if (!configured) {
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
    connectionEl.textContent = `Connected · ${currentStatus.sheetTitle || "ApplicantAlly"}`;
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
    connectionEl.textContent = "Choose ApplicantAlly folder";
  } else if (/AUTH|FORBIDDEN|NOT_FOUND|SCHEMA|INVALID_SERVICE_ACCOUNT|INVALID_SHEET/.test(code)) {
    connectionState = "invalid";
    connectionEl.textContent = "ApplicantAlly needs attention";
  } else {
    connectionState = "offline";
    connectionEl.textContent = "ApplicantAlly is unavailable";
  }
  updateControls();
}

function applyProfiles(result, selected) {
  profileOptions = result;
  const previousError = automaticProfileError;
  automaticProfileError = "";
  profiles = [...new Set((result.profiles || []).filter((value) => typeof value === "string" && value.trim()))];
  profileSelect.replaceChildren(new Option("No profile", ""));
  for (const profile of profiles) profileSelect.append(new Option(result.profileLabels?.[profile] || profile, profile));
  const region = JobProfileRouting.jobRegion(latestPayload);
  if (region) {
    try {
      const routing = JobProfileRouting.snapshot(latestPayload, result);
      if (region === "us" && !captureProfile) {
        profileSelect.append(new Option("Automatic · Kevin Lee or Jagjeet Wani (US)", JobProfileRouting.AUTOMATIC));
        selected = JobProfileRouting.AUTOMATIC;
      } else selected = captureProfile || JobProfileRouting.choose(latestPayload, routing).profile;
    } catch (error) { automaticProfileError = error.message; selected = ""; setStatus(error.message); }
  } else if (selected && !profiles.includes(selected)) {
    profileSelect.append(new Option(`${selected} — unavailable`, selected));
    setStatus("Your saved profile is unavailable. Select a valid profile or No profile before saving.");
  }
  profileSelect.value = selected;
  if (region && !automaticProfileError && previousError && statusEl.textContent === previousError) setStatus(capturedStatus());
  renderJson();
}

function renderSheetStatus(status) {
  configured = Boolean(status.configured);
  connectionState = status.connection || (configured ? "checking" : "unconfigured");
  connected = connectionState === "connected";
  connectionEl.textContent = !configured
    ? "Choose ApplicantAlly folder"
    : connected
      ? `Connected · ${status.sheetTitle || "ApplicantAlly"}`
      : connectionState === "invalid"
        ? "ApplicantAlly needs attention"
        : connectionState === "offline"
          ? "ApplicantAlly is unavailable"
          : "Checking ApplicantAlly…";
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
  captureProfile = null;
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
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/profile-routing.js", "src/scraper.js", "src/content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_LINKEDIN_JOB" });
    }
    if (!response?.ok) throw new Error(response?.error || "The scraper did not return a job.");
    latestPayload = response.data;
    applyProfiles(profileOptions, profileSelect.value);
    for (const name of Object.keys(fields)) fields[name].value = latestPayload[name] || "";
    const applyUrl = safeWebUrl(latestPayload.applyUrl);
    openApplyUrlLink.href = applyUrl || "#";
    openApplyUrlLink.classList.toggle("disabled", !applyUrl);
    renderJson();
    const missing = ["company", "title", "description"].filter((key) => !String(latestPayload[key] || "").trim());
    setStatus(missing.length
      ? `Missing ${missing.join(", ")}. Expand the full job on LinkedIn and scrape again.`
      : connected && !validProfile()
        ? automaticProfileError || "Your saved profile is unavailable. Select a valid profile or No profile before saving."
        : capturedStatus());
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
    heading.textContent = "Already in ApplicantAlly";
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
  return !automaticProfileError && (!profileSelect.value || profileSelect.value === JobProfileRouting.AUTOMATIC || profiles.includes(profileSelect.value));
}
function selectedProfileValue() { return profileSelect.value === JobProfileRouting.AUTOMATIC ? "" : profileSelect.value; }
function capturedStatus() {
  const region = JobProfileRouting.jobRegion(latestPayload);
  return region === "us" ? "Job captured. Research will select Kevin Lee or Jagjeet Wani from the experience requirements."
    : region ? "Job captured. Profile selected from the LinkedIn search location." : "Job captured. Profile is optional.";
}

function canSave() {
  return configured && connected && connectionState === "connected";
}

function updateControls() {
  const complete = latestPayload && ["company", "title", "description"].every((key) => String(latestPayload[key] || "").trim());
  saveButton.disabled = !canSave() || !complete || !validProfile() || saving || scraping || Boolean(duplicate) || isCurrentCompanyBanned();
  saveButton.textContent = saving ? "Saving…" : "Save";
  profileSelect.disabled = !configured || saving || Boolean(JobProfileRouting.jobRegion(latestPayload));
  scrapeButton.disabled = scraping || saving;
  copyJsonButton.disabled = !latestPayload || saving;
}

function renderJson() {
  jsonEl.textContent = JSON.stringify(latestPayload ? { ...latestPayload, profile: selectedProfileValue() } : {}, null, 2);
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
