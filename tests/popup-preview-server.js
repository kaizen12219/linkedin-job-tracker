// Standalone visual fixture: no live Chrome, Kai Flow, LinkedIn, or Sheets calls.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const assets = new Map([
  ["/", ["popup.html", "text/html"]],
  ["/popup.css", ["popup.css", "text/css"]],
  ["/src/popup-kai-flow.js", ["src/popup-kai-flow.js", "text/javascript"]],
  ["/src/tracker-security.js", ["src/tracker-security.js", "text/javascript"]],
  ["/fixture.js", ["tests/popup-preview-fixture.js", "text/javascript"]]
]);
const server = http.createServer(async (request, response) => {
  const resource = assets.get(new URL(request.url, "http://127.0.0.1").pathname);
  if (!resource) { response.writeHead(404); response.end(); return; }
  try {
    let body = await fs.readFile(path.join(root, resource[0]), "utf8");
    if (resource[0] === "popup.html") body = body.replace('<script src="src/popup-kai-flow.js">', '<script src="fixture.js"></script><script src="src/popup-kai-flow.js">');
    response.writeHead(200, { "Content-Type": `${resource[1]}; charset=utf-8`, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'" });
    response.end(body);
  } catch { response.writeHead(500); response.end("Fixture unavailable"); }
});
server.listen(4189, "127.0.0.1", () => console.log("Synthetic popup preview: http://127.0.0.1:4189/"));
