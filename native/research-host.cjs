"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const ORIGIN = "chrome-extension://lomiekljcjnlhfpklnjmmhomknfigofn/";
const ENDPOINT = "http://127.0.0.1:8787/";
const MAX_MESSAGE = 4096;
const failure = (code, message) => Object.assign(new Error(message), { code });
const execute = promisify(execFile);

function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
async function readMessage(input) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) continue;
    const length = buffer.readUInt32LE(0);
    if (!length || length > MAX_MESSAGE) throw failure("INVALID_REQUEST", "Invalid recovery request.");
    if (buffer.length < length + 4) continue;
    if (buffer.length !== length + 4) throw failure("INVALID_REQUEST", "Only one recovery request is allowed.");
    try { return JSON.parse(buffer.subarray(4).toString("utf8")); }
    catch { throw failure("INVALID_REQUEST", "Invalid recovery request."); }
  }
  throw failure("INVALID_REQUEST", "Incomplete recovery request.");
}
function portOpen() {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port: 8787 });
    let done = false;
    const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value); } };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
    socket.setTimeout(600, () => finish(true));
  });
}
async function probeService() {
  try {
    const response = await fetch(ENDPOINT, { redirect: "error", signal: AbortSignal.timeout(1500) });
    const service = await response.json();
    return response.ok && service.name === "resume-template-gated-builder" && Array.isArray(service.tools) &&
      service.tools.includes("complete_job_capture") ? "ready" : "conflict";
  } catch { return await portOpen() ? "conflict" : "stopped"; }
}

async function launchWorker() {
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "research-launcher.ps1")],
    { windowsHide: true, timeout: 22000, maxBuffer: 16384, encoding: "utf8" });
  return JSON.parse(stdout.trim());
}
function createController(config, { probe = probeService, launch = launchWorker } = {}) {
  async function check() {
    const state = await probe();
    if (state === "conflict") throw failure("RESEARCH_PORT_CONFLICT", "Port 8787 is occupied or unresponsive. Close the service using it, then try reconnecting.");
    return { ok: true, status: state, alreadyRunning: state === "ready" };
  }
  async function start() {
    const current = await check();
    if (current.status === "ready") return current;
    if (!path.isAbsolute(config.nodeExecutable || "") || !path.isAbsolute(config.workerRoot || "") || !path.isAbsolute(config.stateDir || "")) {
      throw failure("RESEARCH_HELPER_SETUP", "Reinstall the research recovery helper.");
    }
    try { await Promise.all([config.nodeExecutable, path.join(config.workerRoot, "server.js"), path.join(config.workerRoot, "job-research.js")].map(file => fs.access(file))); }
    catch { throw failure("RESEARCH_FILES_MISSING", "Research files are missing. Reinstall the recovery helper using the current ApplicantAlly package."); }
    // Windows serializes starts with a per-user named mutex. Abandoned mutexes
    // are released by the OS, including after a crash or reboot.
    let result;
    try { result = await launch(); }
    catch { throw failure("RESEARCH_START_FAILED", "Research could not start. Reinstall the recovery helper and try again."); }
    if (result?.ok !== true || result.status !== "ready") throw failure(result?.error?.code || "RESEARCH_START_FAILED", result?.error?.message || "Research could not start.");
    return { ok: true, status: "ready", alreadyRunning: result.alreadyRunning === true };
  }
  return { start, status: check };
}

async function handleRequest(request, origin, config, dependencies) {
  if (origin !== ORIGIN) throw failure("FORBIDDEN", "Only the LinkedIn tracker can use research recovery.");
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).length !== 1 ||
    !["start", "status"].includes(request.action)) throw failure("INVALID_REQUEST", "Only start and status recovery requests are allowed.");
  return createController(config, dependencies)[request.action]();
}

if (require.main === module) {
  (async () => {
    try {
      if (process.argv[2] !== ORIGIN) throw failure("FORBIDDEN", "Only the LinkedIn tracker can use research recovery.");
      const config = JSON.parse(await fs.readFile(path.join(__dirname, "config.json"), "utf8"));
      return await handleRequest(await readMessage(process.stdin), process.argv[2], config);
    } catch (error) {
      return { ok: false, error: { code: error.code || "RESEARCH_HELPER_FAILED", message: error.code ? error.message : "The recovery helper needs to be reinstalled." } };
    }
  })().then(result => process.stdout.write(encodeMessage(result), () => process.exit(0)));
}
module.exports = { ORIGIN, encodeMessage, readMessage, createController, handleRequest };
