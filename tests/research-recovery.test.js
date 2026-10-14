const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { handleRequest, createController, readMessage, encodeMessage, ORIGIN } = require("../native/research-host.cjs");

test("native recovery frames fragmented UTF-8 requests and rejects oversized or malformed input", async () => {
  const frame = encodeMessage({ action: "status" });
  assert.deepEqual(await readMessage(Readable.from([frame.subarray(0, 2), frame.subarray(2, 5), frame.subarray(5)])), { action: "status" });
  const large = Buffer.alloc(4); large.writeUInt32LE(5000);
  await assert.rejects(readMessage(Readable.from([large])), error => error.code === "INVALID_REQUEST");
  await assert.rejects(readMessage(Readable.from([frame.subarray(0, 5)])), error => error.code === "INVALID_REQUEST");
  await assert.rejects(readMessage(Readable.from([Buffer.concat([frame, frame])])), error => error.code === "INVALID_REQUEST");
  const reply = encodeMessage({ ok: false, error: { message: "Research unavailable — reconnect." } });
  assert.equal(reply.readUInt32LE(0), reply.length - 4);
  assert.equal(JSON.parse(reply.subarray(4).toString("utf8")).error.message, "Research unavailable — reconnect.");
});

test("only this extension may request start/status and arbitrary commands or paths are rejected", async () => {
  let touched = false;
  const dependencies = { probe: async () => { touched = true; return "ready"; } };
  await assert.rejects(handleRequest({ action: "start" }, "chrome-extension://another-extension/", {}, dependencies), error => error.code === "FORBIDDEN");
  for (const message of [{ action: "restart" }, { action: "start", command: "anything" }, { action: "start", workerRoot: "anywhere" }, [], null]) {
    await assert.rejects(handleRequest(message, ORIGIN, {}, dependencies), error => error.code === "INVALID_REQUEST");
  }
  assert.equal(touched, false);
  assert.equal((await handleRequest({ action: "status" }, ORIGIN, {}, dependencies)).status, "ready");
});

test("reconnecting to a running worker neither launches nor changes it", async () => {
  let launches = 0;
  const controller = createController({}, { probe: async () => "ready", launch: async () => { launches++; } });
  assert.deepEqual(await controller.start(), { ok: true, status: "ready", alreadyRunning: true });
  assert.equal(launches, 0);
});

test("a port conflict is actionable and cannot authorize launching or stopping another service", async () => {
  let launches = 0;
  const controller = createController({}, { probe: async () => "conflict", launch: async () => { launches++; } });
  await assert.rejects(controller.start(), error => error.code === "RESEARCH_PORT_CONFLICT");
  assert.equal(launches, 0);
});
