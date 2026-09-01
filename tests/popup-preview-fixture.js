// Synthetic browser UI only; every save is simulated in memory.
const fixtureMode = new URLSearchParams(location.search).get("mode");
const fixtureStorage = {};
let fixtureSaved = false;
const fixtureJob = { company: "Example Systems", title: "Senior Software Engineer", description: "Build reliable tools for distributed teams.\n\nResponsibilities\n" + "Work with the product team to improve the experience.\n".repeat(35), applyUrl: "https://jobs.example.test/engineer" };
window.chrome = {
  permissions: { request: async () => true },
  runtime: { sendMessage: async (message) => {
    if (["KAI_TRACKER_STATUS", "KAI_TRACKER_RETRY", "KAI_TRACKER_CANCEL", "KAI_TRACKER_PAIR"].includes(message.type)) return { ok: true, result: { paired: fixtureMode !== "unpaired", origin: "https://kai.example.test", connection: fixtureMode === "offline" ? "offline" : "connected", entries: [] } };
    if (fixtureMode === "offline" && message.type !== "KAI_TRACKER_SAVE") return { ok: false, error: { code: "TRACKER_OFFLINE", message: "The central Kai Flow server is unavailable. New saves remain queued." } };
    if (message.type === "KAI_TRACKER_OPTIONS") return { ok: true, result: { profiles: ["sample-profile-a", "sample-profile-b"], destination: "Kai Flow" } };
    if (message.type === "KAI_TRACKER_DUPLICATE") return { ok: true, result: { duplicate: fixtureMode === "duplicate" || fixtureSaved ? { company: fixtureJob.company, jobTitle: fixtureJob.title, status: "added", jobDescriptionPreview: "Build reliable tools for distributed teams." } : null } };
    if (fixtureMode === "uncertain") return { ok: false, error: { code: "TRACKER_SAVE_UNCERTAIN", message: "Save not confirmed. Check Kai Flow before trying again. This request will not be sent twice." } };
    if (fixtureMode === "offline") return { ok: true, result: { status: "queued", state: "retry" } };
    fixtureSaved = true;
    return { ok: true, result: { status: "inserted", job: { ...fixtureJob, profile: message.profile, status: "added" } } };
  } },
  storage: { local: { get: async (key) => ({ [key]: fixtureStorage[key] }), set: async (values) => Object.assign(fixtureStorage, values) } },
  tabs: { query: async () => [{ id: 1, url: "https://www.linkedin.com/jobs/view/1" }], sendMessage: async () => ({ ok: true, data: fixtureJob }) },
  scripting: { executeScript: async () => {} }
};
