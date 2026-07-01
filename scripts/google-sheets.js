const crypto = require("crypto");
const fs = require("fs/promises");
const https = require("https");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const CELL_LIMIT = 49000;

async function saveJobIfCompanyMissing(options) {
  const { credentialsPath, spreadsheetId, sheetGid, job } = options;
  const normalizedJob = normalizeJob(job);
  const token = await getAccessToken(credentialsPath);
  const sheet = await getSheetByGid({ token, spreadsheetId, sheetGid });
  const companyColumnRange = `${quoteSheetName(sheet.title)}!B:B`;
  const companies = await getValues({ token, spreadsheetId, range: companyColumnRange });
  const normalizedCompany = normalizeCompany(normalizedJob.company);
  const alreadyExists = companies.some((row) => normalizeCompany(row[0]) === normalizedCompany);
  const nextRow = companies.length + 1;

  if (alreadyExists) {
    return {
      status: "duplicate",
      company: normalizedJob.company,
      sheetTitle: sheet.title,
      message: `Skipped because ${normalizedJob.company} already exists in column B.`
    };
  }

  const updateRange = `${quoteSheetName(sheet.title)}!B${nextRow}:E${nextRow}`;
  const updateResult = await updateValues({
    token,
    spreadsheetId,
    range: updateRange,
    values: [[
      normalizedJob.company,
      normalizedJob.title,
      normalizedJob.description,
      normalizedJob.applyUrl
    ]]
  });

  return {
    status: "inserted",
    company: normalizedJob.company,
    sheetTitle: sheet.title,
    updatedRange: updateResult.updatedRange || "",
    warnings: normalizedJob.warnings
  };
}

async function checkSheetAccess(options) {
  const { credentialsPath, spreadsheetId, sheetGid } = options;
  const token = await getAccessToken(credentialsPath);
  const sheet = await getSheetByGid({ token, spreadsheetId, sheetGid });
  const companies = await getValues({
    token,
    spreadsheetId,
    range: `${quoteSheetName(sheet.title)}!B:B`
  });

  return {
    ok: true,
    sheetTitle: sheet.title,
    companyRowsRead: companies.length
  };
}

async function getAccessToken(credentialsPath) {
  if (!credentialsPath) {
    throw new Error("Missing service account credentials path.");
  }

  const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8"));

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Service account file is missing client_email or private_key.");
  }

  const assertion = createJwt(credentials);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  }).toString();
  const response = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });

  if (!response.access_token) {
    throw new Error("Google OAuth response did not include an access token.");
  }

  return response.access_token;
}

function createJwt(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT"
  };
  const claim = {
    iss: credentials.client_email,
    scope: SHEETS_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(credentials.private_key);

  return `${unsigned}.${base64Url(signature)}`;
}

async function getSheetByGid(options) {
  const { token, spreadsheetId, sheetGid } = options;
  const metadata = await sheetsRequest({
    token,
    method: "GET",
    path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`
  });
  const numericGid = Number(sheetGid);
  const sheet = metadata.sheets
    ?.map((entry) => entry.properties)
    .find((properties) => Number(properties.sheetId) === numericGid);

  if (!sheet) {
    throw new Error(`No sheet found for gid ${sheetGid}.`);
  }

  return sheet;
}

async function getValues(options) {
  const { token, spreadsheetId, range } = options;
  const response = await sheetsRequest({
    token,
    method: "GET",
    path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`
  });

  return response.values || [];
}

async function updateValues(options) {
  const { token, spreadsheetId, range, values } = options;

  return sheetsRequest({
    token,
    method: "PUT",
    path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    body: { values }
  });
}

function sheetsRequest(options) {
  const { token, method, path, body } = options;
  const payload = body ? JSON.stringify(body) : undefined;

  return requestJson(`https://sheets.googleapis.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          }
        : {})
    },
    body: payload
  });
}

function requestJson(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method,
      headers: options.headers
    }, (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = {};

        if (raw) {
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            reject(new Error(`Expected JSON from Google API, received: ${raw.slice(0, 300)}`));
            return;
          }
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const detail = parsed.error?.message || raw.slice(0, 300) || response.statusMessage;
          reject(new Error(`Google API request failed (${response.statusCode}): ${detail}`));
          return;
        }

        resolve(parsed);
      });
    });

    request.setTimeout(30000, () => {
      request.destroy(new Error("Google API request timed out."));
    });
    request.on("error", reject);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

function normalizeJob(job) {
  const normalized = {
    company: cleanCell(job?.company),
    title: cleanCell(job?.title || job?.jobTitle),
    description: cleanCell(job?.description || job?.jobDescription),
    applyUrl: cleanCell(job?.applyUrl || job?.url),
    warnings: []
  };

  if (!normalized.company) {
    throw new Error("Missing company.");
  }

  for (const field of ["company", "title", "description", "applyUrl"]) {
    if (normalized[field].length > CELL_LIMIT) {
      normalized[field] = normalized[field].slice(0, CELL_LIMIT);
      normalized.warnings.push(`${field} was truncated to fit Google Sheets cell limits.`);
    }
  }

  return normalized;
}

function cleanCell(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function normalizeCompany(value) {
  return cleanCell(value)
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

module.exports = {
  saveJobIfCompanyMissing,
  checkSheetAccess,
  normalizeCompany
};
