// Synthetic browser UI only; every save is simulated in memory.
const fixtureMode = new URLSearchParams(location.search).get("mode");
const fixtureStorage = {};
let fixtureSaved = false;
let fixtureResearchModel = fixtureMode === "model-unavailable" ? "retired-model" : "";
let fixtureResearchEffort = fixtureMode === "level-unavailable" ? "retired-level" : "";
const fixtureModels = [
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "medium" },
  { id: "gpt-6-luna", name: "GPT-6-Luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" }
];
let fixtureResearchOnline = !["models-offline", "offline"].includes(fixtureMode);
const fixtureJob = { company: "Example Systems", title: "Senior Software Engineer", description: "Build reliable tools for distributed teams.\n\nResponsibilities\n" + "Work with the product team to improve the experience.\n".repeat(35), applyUrl: "https://jobs.example.test/engineer" };
window.chrome = {
  runtime: { sendMessage: async (message) => {
    if (message.type === "KAI_TRACKER_STATUS") return { ok: true, result: {
      configured: fixtureMode !== "unconfigured",
      connection: fixtureMode === "unconfigured" ? "unconfigured" : fixtureMode === "offline" ? "offline" : "connected",
      sheetUrl: "https://docs.google.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyzABCDE/edit#gid=123",
      sheetGid: 123,
      sheetTitle: "Jobs",
      profileOptions: { profiles: ["sample-profile-a", "sample-profile-b"] }
    } };
    if (message.type === "KAI_TRACKER_CONFIGURE") return { ok: true, result: { configured: true, connection: "connected", sheetTitle: "Jobs", sheetGid: 123 } };
    if (message.type === "KAI_TRACKER_CLEAR_CONFIG") return { ok: true, result: { configured: false, connection: "unconfigured" } };
    if (message.type === "KAI_TRACKER_BANNED_GET") return { ok: true, result: { companies: [] } };
    if (message.type === "KAI_TRACKER_BANNED_SET") return { ok: true, result: { companies: message.companies || [] } };
    if (message.type === "KAI_TRACKER_RESEARCH_START") {
      const alreadyRunning = fixtureResearchOnline;
      fixtureResearchOnline = true;
      return { ok: true, result: { status: "ready", alreadyRunning } };
    }
    if (["KAI_TRACKER_RESEARCH_MODELS", "KAI_TRACKER_RESEARCH_MODEL_SET", "KAI_TRACKER_RESEARCH_EFFORT_SET"].includes(message.type)) {
      if (!fixtureResearchOnline) return { ok: false, error: { code: "RESEARCH_UNAVAILABLE", message: "The research worker is unavailable. Click Start / reconnect research to load the AI models." } };
      if (message.type === "KAI_TRACKER_RESEARCH_MODEL_SET") {
        fixtureResearchModel = message.model;
        if (fixtureResearchEffort && !fixtureModels.find(model => model.id === (fixtureResearchModel || "gpt-6.1-sol"))?.reasoningEfforts.includes(fixtureResearchEffort)) fixtureResearchEffort = "";
        return { ok: true, result: { selectedModel: fixtureResearchModel, selectedReasoningEffort: fixtureResearchEffort } };
      }
      if (message.type === "KAI_TRACKER_RESEARCH_EFFORT_SET") {
        fixtureResearchEffort = message.reasoningEffort;
        return { ok: true, result: { selectedModel: fixtureResearchModel, selectedReasoningEffort: fixtureResearchEffort } };
      }
      return { ok: true, result: { models: fixtureModels, defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "xhigh", selectedModel: fixtureResearchModel, selectedReasoningEffort: fixtureResearchEffort } };
    }
    if (fixtureMode === "offline" && message.type !== "KAI_TRACKER_SAVE") return { ok: false, error: { code: "TRACKER_OFFLINE", message: "Google Sheets is unavailable. Nothing is queued." } };
    if (message.type === "KAI_TRACKER_OPTIONS") return { ok: true, result: { profiles: ["sample-profile-a", "sample-profile-b"] } };
    if (message.type === "KAI_TRACKER_DUPLICATE") return { ok: true, result: { duplicate: fixtureMode === "duplicate" || fixtureSaved ? { company: fixtureJob.company, jobTitle: fixtureJob.title, status: "added", jobDescriptionPreview: "Build reliable tools for distributed teams." } : null } };
    if (fixtureMode === "uncertain") return { ok: false, error: { code: "TRACKER_SAVE_UNCONFIRMED", message: "Save not confirmed. Nothing will retry automatically; check the Google Sheet before trying again." } };
    if (fixtureMode === "offline") return { ok: false, error: { code: "TRACKER_OFFLINE", message: "Google Sheets unavailable. Nothing was queued." } };
    fixtureSaved = true;
    return { ok: true, result: { status: "inserted", job: { ...fixtureJob, profile: message.profile, status: "added" } } };
  } },
  storage: { local: { get: async (key) => ({ [key]: fixtureStorage[key] }), set: async (values) => Object.assign(fixtureStorage, values) } },
  tabs: { query: async () => [{ id: 1, url: "https://www.linkedin.com/jobs/view/1" }], sendMessage: async () => ({ ok: true, data: fixtureJob }) },
  scripting: { executeScript: async () => {} }
};
