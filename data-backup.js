"use strict";

/**
 * Optional cloud backup for data.json via the GitHub Contents API.
 *
 * Set on Render (Environment):
 *   GITHUB_TOKEN  — fine-grained or classic token with repo Contents read/write
 *   GITHUB_REPO   — optional, default Jamesha123/ToDoLists
 *   GITHUB_BRANCH — optional, default main
 *
 * After each local save, a backup is queued (debounced ~90s). On startup the
 * server pulls from GitHub if that copy is newer than the file on disk.
 */

const https = require("https");

const REPO = process.env.GITHUB_REPO || "Jamesha123/ToDoLists";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const FILE_PATH = process.env.GITHUB_DATA_PATH || "data.json";
const TOKEN = process.env.GITHUB_TOKEN || "";
const DEBOUNCE_MS = Number(process.env.GITHUB_BACKUP_DEBOUNCE_MS) || 90_000;

let backupTimer = null;
let pendingJson = null;
let pendingSavedAt = 0;
let lastBackedUpAt = 0;
let pushing = false;
let lastAttemptAt = 0;
let lastOkAt = 0;
let lastError = "";

function configured() {
  return Boolean(TOKEN && REPO.includes("/"));
}

function githubRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = https.request(
      {
        hostname: "api.github.com",
        path: apiPath,
        method,
        headers: {
          "User-Agent": "Lists-Data-Backup",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${TOKEN}`,
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed = null;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { message: raw };
            }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          const err = new Error((parsed && parsed.message) || `GitHub API ${res.statusCode}`);
          err.status = res.statusCode;
          reject(err);
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function apiPath(suffix) {
  const [owner, repo] = REPO.split("/");
  return `/repos/${owner}/${repo}${suffix}`;
}

/** Fetch data.json from GitHub. Returns { data, savedAt, sha } or null. */
async function fetchRemote() {
  if (!configured()) return null;
  try {
    const meta = await githubRequest("GET", `${apiPath(`/contents/${FILE_PATH}`)}?ref=${encodeURIComponent(BRANCH)}`);
    const text = Buffer.from(meta.content, meta.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    const data = JSON.parse(text);
    return { data, savedAt: Number(data._savedAt) || 0, sha: meta.sha };
  } catch (err) {
    if (err.status === 404) return null;
    console.error("GitHub backup fetch failed:", err.message);
    return null;
  }
}

async function pushToGitHub(json, sha) {
  const body = {
    message: `backup: data.json (${new Date().toISOString()})`,
    content: Buffer.from(json, "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  await githubRequest("PUT", apiPath(`/contents/${FILE_PATH}`), body);
}

async function runBackup() {
  if (!configured() || !pendingJson || pushing) return;
  const json = pendingJson;
  const savedAt = pendingSavedAt;
  if (savedAt <= lastBackedUpAt) return;

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return;
  }

  pushing = true;
  lastAttemptAt = Date.now();
  try {
    let remote = await fetchRemote();
    const remoteHasData = hasListData(remote && remote.data);
    const localHasData = hasListData(parsed);
    // Don't overwrite a good GitHub backup with an empty server state.
    if (!localHasData && remoteHasData) return;

    try {
      await pushToGitHub(json, remote && remote.sha);
    } catch (err) {
      if (err.status !== 409) throw err;
      remote = await fetchRemote();
      await pushToGitHub(json, remote && remote.sha);
    }
    lastBackedUpAt = savedAt;
    lastOkAt = Date.now();
    lastError = "";
    console.log("Backed up data.json to GitHub");
  } catch (err) {
    lastError = String((err && err.message) || err || "unknown error");
    console.error("GitHub backup failed:", err.message);
  } finally {
    pushing = false;
  }
}

function hasListData(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (Array.isArray(parsed.lists) && parsed.lists.length > 0) return true;
  if (Array.isArray(parsed.todos) && parsed.todos.length > 0) return true;
  return false;
}

/** Queue a backup after the debounce window (coalesces rapid edits). */
function schedule(json, savedAt) {
  if (!configured()) return;
  pendingJson = json;
  pendingSavedAt = savedAt;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => runBackup(), DEBOUNCE_MS);
}

/** Push immediately (e.g. before Render shuts down for deploy). */
async function flush() {
  clearTimeout(backupTimer);
  await runBackup();
}

function status() {
  return {
    configured: configured(),
    repo: REPO,
    branch: BRANCH,
    path: FILE_PATH,
    debounceMs: DEBOUNCE_MS,
    pushing,
    pendingSavedAt,
    lastBackedUpAt,
    lastAttemptAt,
    lastOkAt,
    lastError,
  };
}

module.exports = { configured, fetchRemote, schedule, flush, status };
