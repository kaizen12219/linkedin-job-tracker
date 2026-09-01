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
const pairingSettings = document.querySelector("#pairingSettings");
const pairingLink = document.querySelector("#pairingLink");
const deviceName = document.querySelector("#deviceName");
const connectButton = document.querySelector("#connectServer");
const queueSummary = document.querySelector("#queueSummary");
const queueList = document.querySelector("#queueList");
const fields = Object.fromEntries(["title", "company", "applyUrl", "description"]
  .map((name) => [name, document.querySelector(`#${name}`)]));
const PROFILE_KEY = "kaiFlowSelectedProfile";
let latestPayload = null;
let profiles = [];
let connected = false;
let scraping = false;
let saving = false;
let duplicate = null;
let lookupVersion = 0;
let optionsVersion = 0;
let uncertain = false;
let paired = false;
let connectionState = "unpaired";
let remoteOrigin = "";
let queueEntries = [];
let duplicateTimer;

document.addEventListener("DOMContentLoaded", () => {
  void loadOptions();
  void scrapeCurrentTab();
});
chrome.runtime.onMessage?.addListener((message, sender) => {
  if (sender?.id === chrome.runtime.id && message?.type === "KAI_TRACKER_PROFILES_CHANGED") void loadOptions(true);
  if (sender?.id === chrome.runtime.id && message?.type === "KAI_TRACKER_QUEUE_CHANGED") void loadStatus();
});
scrapeButton.addEventListener("click", () => void scrapeCurrentTab());
refreshButton.addEventListener("click", async () => {
  // The optional permission request stays inside the user's click gesture.
  if (remoteOrigin) {
    try { if (!await chrome.permissions.request({ origins: [`${remoteOrigin}/*`] })) { setStatus("Access to the Kai Flow server was not granted."); return; } }
    catch { setStatus("Could not request access to the configured server."); return; }
  }
  await loadOptions(true);
  void request({ type: "KAI_TRACKER_RETRY" }).then(renderRemoteStatus).catch((error) => setStatus(error.message));
});
connectButton.addEventListener("click", async () => {
  let parsed;
  try { parsed = KaiFlowTrackerSecurity.parsePairingLink(pairingLink.value); }
  catch (error) { setStatus(error.message); return; }
  const link = pairingLink.value.trim();
  // Never ask for https://*/* at runtime: only this explicitly chosen origin.
  const permission = chrome.permissions.request({ origins: [parsed.permission] });
  connectButton.disabled = true;
  try {
    if (!await permission) throw new Error("Server access was not granted. Nothing was connected.");
    const result = await request({ type: "KAI_TRACKER_PAIR", link, deviceName: deviceName.value });
    pairingLink.value = "";
    renderRemoteStatus(result);
    pairingSettings.open = false;
    setStatus("Connected. Earlier queued jobs stay with their original connection.");
    await loadOptions(true);
  } catch (error) {
    setStatus(error.message);
  } finally { connectButton.disabled = false; }
});
for (const [name, input] of Object.entries(fields)) input.addEventListener("input", () => {
  latestPayload = { ...(latestPayload || {}), [name]: input.value };
  uncertain = false;
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
  renderJson(); updateControls();
});
profileSelect.addEventListener("change", async () => {
  uncertain = false;
  try {
    await chrome.storage.local.set({ [PROFILE_KEY]: profileSelect.value });
    setStatus(profileSelect.value ? `Profile: ${profileSelect.value}.` : "No profile selected. You can assign one later in Kai Flow.");
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
  } catch { setStatus("Could not copy. You can select the text under Raw JSON."); }
});
openApplyUrlLink.addEventListener("click", (event) => {
  if (openApplyUrlLink.classList.contains("disabled")) event.preventDefault();
});
saveButton.addEventListener("click", async () => {
  if (saving || scraping || !latestPayload || !canSave() || !validProfile() || duplicate) return;
  saving = true;
  updateControls();
  setStatus(uncertain ? "Checking the previous save…" : "Saving to Kai Flow…");
  try {
    const result = await request({ type: "KAI_TRACKER_SAVE", job: latestPayload, profile: profileSelect.value });
    uncertain = false;
    setStatus(result.status === "queued" ? result.state === "review" ? "This save needs an owner check. The original request is retained in the queue." : "Saved in the queue. It will retry automatically while this browser is running." : result.status === "canceled" ? "This request was canceled. Check the queue before adding it again." : result.replayed ? "Already saved in Kai Flow. No duplicate was created." : "Saved to Kai Flow · Pending. All connected dashboards will update automatically.");
    await loadStatus();
    if (result.status === "inserted") void checkDuplicate();
  } catch (error) {
    if (error.code === "DUPLICATE_COMPANY" && error.details?.duplicate) {
      renderDuplicate(error.details.duplicate);
      setStatus("This company already has a job in Kai Flow. Nothing was added.");
    } else {
      uncertain = /UNCERTAIN|UNCONFIRMED|NOT_CONFIRMED/.test(error.code || "");
      setStatus(error.message);
      if (/UNAVAILABLE|DISCONNECTED|CONNECT|OFFLINE/.test(error.code || "") && !uncertain) {
        connected = false;
        connectionState = "offline";
        connectionEl.textContent = "Server unavailable · saves stay queued";
      }
    }
  } finally {
    saving = false;
    updateControls();
  }
});

async function request(message) {
  let response;
  try { response = await chrome.runtime.sendMessage(message); }
  catch {
    const error = new Error("The tracker could not confirm the request. Reload the extension; check Kai Flow before retrying a save.");
    error.code = message.type === "KAI_TRACKER_SAVE" ? "TRACKER_SAVE_UNCERTAIN" : "TRACKER_UNAVAILABLE";
    throw error;
  }
  if (!response?.ok) {
    const error = new Error(response?.error?.message || "Kai Flow could not complete this request.");
    error.code = response?.error?.code || "TRACKER_UNAVAILABLE";
    error.details = response?.error?.details;
    throw error;
  }
  return response.result;
}

async function loadOptions(refresh = false) {
  const version = ++optionsVersion;
  refreshButton.disabled = true;
  connectionEl.textContent = "Connecting to Kai Flow…";
  try {
    const currentStatus = await request({ type: "KAI_TRACKER_STATUS" });
    if (version !== optionsVersion) return;
    renderRemoteStatus(currentStatus);
    if (!paired) { pairingSettings.open = true; return; }
    const saved = await chrome.storage.local.get(PROFILE_KEY);
    if (version !== optionsVersion) return;
    const selected = typeof saved[PROFILE_KEY] === "string" ? saved[PROFILE_KEY] : "";
    applyProfiles(currentStatus.profileOptions || { profiles: [] }, selected);
    const result = await request({ type: "KAI_TRACKER_OPTIONS", refresh });
    if (version !== optionsVersion) return;
    applyProfiles(result, selected);
    connected = true;
    connectionState = "connected";
    connectionEl.textContent = `Connected · ${new URL(remoteOrigin).host}`;
    renderJson();
    void checkDuplicate();
  } catch (error) {
    if (version !== optionsVersion) return;
    connected = false;
    connectionState = /PAIRING_REQUIRED|EXPIRED|REVOKED/.test(error.code || "") ? "expired" : "offline";
    connectionEl.textContent = connectionState === "expired" ? "Connection expired or revoked · reconnect" : "Server unavailable · saves stay queued";
    setStatus(error.message);
  } finally {
    if (version === optionsVersion) {
      refreshButton.disabled = false;
      updateControls();
    }
  }
}

function applyProfiles(result, selected) {
  profiles = [...new Set((result.profiles || []).filter((value) => typeof value === "string" && value.trim()))];
  profileSelect.replaceChildren(new Option("No profile", ""));
  for (const profile of profiles) profileSelect.append(new Option(result.profileLabels?.[profile] || profile, profile));
  if (selected && !profiles.includes(selected)) {
    profileSelect.append(new Option(`${selected} — unavailable`, selected));
    setStatus("Your saved profile is unavailable. Select a valid profile or No profile before saving.");
  }
  // A stale or offline selection is never silently assigned to someone else.
  profileSelect.value = selected;
  renderJson();
}

async function loadStatus() {
  try { renderRemoteStatus(await request({ type: "KAI_TRACKER_STATUS" })); }
  catch (error) { setStatus(error.message); }
}
function renderRemoteStatus(status) {
  paired = Boolean(status.paired);
  remoteOrigin = status.origin || "";
  connectionState = status.connection || (paired ? "checking" : "unpaired");
  connected = connectionState === "connected";
  connectionEl.textContent = !paired ? "Not connected · use a pairing link" : connectionState === "expired" || connectionState === "revoked" ? "Connection expired or revoked · reconnect" : connected ? `Connected · ${new URL(remoteOrigin).host}` : connectionState === "offline" ? "Server unavailable · saves stay queued" : "Checking the Kai Flow server…";
  queueEntries = Array.isArray(status.entries) ? status.entries : [];
  const waiting = queueEntries.filter((entry) => !["saved", "canceled", "rejected"].includes(entry.state)).length;
  queueSummary.textContent = waiting ? `Save queue · ${waiting} waiting` : "Save queue";
  queueList.replaceChildren();
  const ordered = [...queueEntries].sort((a, b) => b.updatedAt - a.updatedAt);
  const isOpen = (entry) => !["saved", "canceled", "rejected"].includes(entry.state);
  // Every unresolved request must remain reachable for cancellation, even during large outages.
  const visible = [...ordered.filter(isOpen), ...ordered.filter((entry) => !isOpen(entry)).slice(0, 20)];
  if (!visible.length) { const empty = document.createElement("p"); empty.textContent = "No queued saves."; queueList.append(empty); }
  for (const entry of visible) {
    const item = document.createElement("div"); item.className = "queue-item";
    const title = document.createElement("strong"); title.textContent = `${entry.company} · ${entry.jobTitle}`;
    const info = document.createElement("p");
    const labels = { queued: "Queued", sending: "Sending…", retry: "Queued · retrying every 30 seconds", "auth-paused": "Paused · connection needs attention", review: "Needs owner check · automatic retry stopped", saved: "Saved", rejected: "Not saved", canceled: entry.mayHaveSaved ? "Retries canceled · may already be saved" : "Canceled · not sent" };
    info.textContent = !entry.connectionMatches && !["saved", "rejected", "canceled"].includes(entry.state) ? `Paused · earlier connection (${entry.origin}). Not transferred to this server or pairing.` : labels[entry.state] || "Needs attention";
    item.append(title, info);
    if (entry.error?.message && entry.state !== "saved") { const details = document.createElement("p"); details.textContent = entry.error.message; item.append(details); }
    if (!["saved", "rejected", "canceled"].includes(entry.state)) {
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary"; cancel.textContent = "Cancel retries";
      cancel.addEventListener("click", async () => {
        const message = entry.mayHaveSaved ? "Cancel automatic retries? This request may already have reached Kai Flow. Canceling will not remove a saved job. Check with the owner before adding it again." : "Cancel this queued save? The tracker will not send it.";
        if (!confirm(message)) return;
        cancel.disabled = true;
        try { renderRemoteStatus(await request({ type: "KAI_TRACKER_CANCEL", requestId: entry.requestId })); }
        catch (error) { setStatus(error.message); cancel.disabled = false; }
      });
      item.append(cancel);
    }
    queueList.append(item);
  }
  if (queueEntries.length > visible.length) { const more = document.createElement("p"); more.textContent = `${queueEntries.length - visible.length} older records retained safely.`; queueList.append(more); }
  updateControls();
}

async function scrapeCurrentTab() {
  if (scraping || saving) return;
  scraping = true;
  uncertain = false;
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
  if (!connected || !latestPayload?.company) return;
  try {
    const result = await request({ type: "KAI_TRACKER_DUPLICATE", company: latestPayload.company });
    if (version === lookupVersion) renderDuplicate(result.duplicate || null);
  } catch {
    // The authoritative check still runs on Save; a failed preview must never
    // claim there is no duplicate or skip that server-side check.
    if (version === lookupVersion) renderDuplicate(null);
  }
}

function renderDuplicate(value) {
  duplicate = value;
  duplicateEl.replaceChildren();
  duplicateEl.hidden = !value;
  if (value) {
    const heading = document.createElement("strong");
    heading.textContent = "Already in Kai Flow";
    const title = document.createElement("span");
    title.textContent = `${value.company || ""} · ${value.jobTitle || "Existing job"}`;
    const status = document.createElement("span");
    status.textContent = value.status === "added" ? "Pending" : String(value.status || "");
    const preview = document.createElement("p");
    preview.textContent = String(value.jobDescriptionPreview || "");
    duplicateEl.append(heading, title, status, preview);
  }
  updateControls();
}
function validProfile() { return !profileSelect.value || profiles.includes(profileSelect.value); }
function canSave() { return paired && !["expired", "revoked", "unpaired"].includes(connectionState); }
function updateControls() {
  const complete = latestPayload && ["company", "title", "description"].every((key) => String(latestPayload[key] || "").trim());
  const pending = queueEntries.find((entry) => entry.company?.toLowerCase().trim() === latestPayload?.company?.toLowerCase().trim() && entry.connectionMatches && (!["saved", "rejected", "canceled"].includes(entry.state) || (entry.state === "canceled" && entry.mayHaveSaved)));
  saveButton.disabled = !canSave() || !complete || !validProfile() || saving || scraping || Boolean(duplicate && !uncertain) || Boolean(pending);
  saveButton.textContent = saving ? "Saving…" : pending ? "In queue" : uncertain ? "Check save" : connected ? "Save" : "Queue save";
  profileSelect.disabled = !paired || saving;
  scrapeButton.disabled = scraping || saving;
  copyJsonButton.disabled = !latestPayload || saving;
}
function renderJson() { jsonEl.textContent = JSON.stringify(latestPayload ? { ...latestPayload, profile: profileSelect.value } : {}, null, 2); }
function setStatus(message) { statusEl.textContent = message; }
function safeWebUrl(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : ""; }
  catch { return ""; }
}
function isSupportedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) && url.pathname.startsWith("/jobs");
  } catch { return false; }
}
