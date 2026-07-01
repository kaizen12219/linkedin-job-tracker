const http = require("http");
const { saveJobIfCompanyMissing, checkSheetAccess } = require("./google-sheets");

const DEFAULT_SPREADSHEET_ID = "1arOqpFZYqsjAKL-whYlQhQ9Veeep66oAG88xc20NeIg";
const DEFAULT_SHEET_GID = "1956783810";
const DEFAULT_CREDENTIALS_PATH = "D:\\rezi-builder-mcp\\rezi-builder-95b56753ae45.json";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const config = readConfig();

  if (config.checkOnly) {
    const result = await checkSheetAccess(config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (config.oncePayload) {
    const result = await saveJobIfCompanyMissing({
      ...config,
      job: config.oncePayload
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response, config).catch((error) => {
      sendJson(response, error.statusCode || 500, {
        ok: false,
        error: error.message
      });
    });
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`LinkedIn Job Scraper Sheets bridge listening on http://127.0.0.1:${config.port}`);
    console.log(`Target spreadsheet: ${config.spreadsheetId}, gid: ${config.sheetGid}`);
  });
}

async function handleRequest(request, response, config) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      spreadsheetId: config.spreadsheetId,
      sheetGid: config.sheetGid
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/jobs") {
    const job = await readJsonBody(request);
    const result = await saveJobIfCompanyMissing({
      ...config,
      job
    });

    sendJson(response, 200, {
      ok: true,
      ...result
    });
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: "Not found."
  });
}

function readConfig() {
  const args = process.argv.slice(2);
  const onceJson = getArg(args, "--json");
  const oncePayload = onceJson ? JSON.parse(onceJson) : null;

  return {
    spreadsheetId: getArg(args, "--spreadsheet-id") || process.env.SHEET_ID || DEFAULT_SPREADSHEET_ID,
    sheetGid: getArg(args, "--gid") || process.env.SHEET_GID || DEFAULT_SHEET_GID,
    credentialsPath: getArg(args, "--credentials") || process.env.GOOGLE_APPLICATION_CREDENTIALS || DEFAULT_CREDENTIALS_PATH,
    port: Number(getArg(args, "--port") || process.env.SHEETS_BRIDGE_PORT || DEFAULT_PORT),
    checkOnly: args.includes("--check"),
    oncePayload
  };
}

function getArg(args, name) {
  const index = args.indexOf(name);

  if (index === -1) {
    return "";
  }

  return args[index + 1] || "";
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        const parseError = new Error("Request body must be valid JSON.");
        parseError.statusCode = 400;
        reject(parseError);
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  setCorsHeaders(response);
  const body = JSON.stringify(payload, null, 2);

  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
