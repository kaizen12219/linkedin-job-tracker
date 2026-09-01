(function registerTrackerSecurity(root) {
  "use strict";
  function parseOrigin(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("Use the HTTPS pairing link from the Kai Flow owner."); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "0.0.0.0" || /^127\./.test(host)) {
      throw new Error("Kai Flow needs a remote HTTPS address, not a local connection.");
    }
    return url.origin;
  }
  function parsePairingLink(value) {
    const url = new URL(String(value).trim());
    const origin = parseOrigin(url.href);
    if (url.pathname !== "/" || url.search || !/^#tracker-pair=[A-Za-z0-9_-]{16,256}$/.test(url.hash)) {
      throw new Error("Paste the complete pairing link from Kai Flow → Job tracker.");
    }
    return { origin, code: url.hash.slice("#tracker-pair=".length), permission: `${origin}/*` };
  }
  root.KaiFlowTrackerSecurity = Object.freeze({ parseOrigin, parsePairingLink });
})(globalThis);
