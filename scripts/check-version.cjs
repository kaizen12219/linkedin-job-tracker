"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const lock = readJson("package-lock.json");
const versions = {
  "manifest.json": manifest.version,
  "package.json": packageJson.version,
  "package-lock.json": lock.version,
  "package-lock.json packages[root]": lock.packages?.[""]?.version
};

if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || Object.values(versions).some((version) => version !== manifest.version)) {
  process.stderr.write(`Release versions must match and use major.minor.patch: ${JSON.stringify(versions)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Release version ${manifest.version} is consistent.\n`);
}
