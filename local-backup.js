"use strict";

/**
 * Local rotating backups for data.json.
 *
 * - Before each save, the current file is copied to backups/ (timestamped).
 * - Writes use a temp file + rename so a crash mid-write won't corrupt data.
 * - On startup, if data.json is missing, unreadable, or empty while backups
 *   exist, the newest backup with list data is restored automatically.
 */

const fs = require("fs");
const path = require("path");

const MAX_BACKUPS = Number(process.env.LOCAL_BACKUP_KEEP) || 30;

function backupDirFor(dataFile) {
  return path.join(path.dirname(dataFile), "backups");
}

function listBackupFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("data-") && name.endsWith(".json"))
    .map((name) => ({ name, full: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function hasListData(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (Array.isArray(parsed.lists) && parsed.lists.length > 0) return true;
  if (Array.isArray(parsed.todos) && parsed.todos.length > 0) return true;
  return false;
}

function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function pruneBackups(dir) {
  const files = listBackupFiles(dir);
  for (const entry of files.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(entry.full);
    } catch (err) {
      console.error("Failed to prune old backup:", entry.name, err.message);
    }
  }
}

/** Copy the current data file into backups/ before it is overwritten. */
function snapshotBeforeWrite(dataFile) {
  if (!fs.existsSync(dataFile)) return;
  let stat;
  try {
    stat = fs.statSync(dataFile);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size === 0) return;

  const dir = backupDirFor(dataFile);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(dataFile, path.join(dir, `data-${stamp}.json`));
    pruneBackups(dir);
  } catch (err) {
    console.error("Local backup snapshot failed:", err.message);
  }
}

/** Write JSON atomically: temp file in the same directory, then rename. */
function writeAtomic(dataFile, json) {
  const dir = path.dirname(dataFile);
  const tmp = path.join(dir, `.${path.basename(dataFile)}.tmp`);
  fs.writeFileSync(tmp, json, "utf8");
  fs.renameSync(tmp, dataFile);
}

/**
 * If data.json is missing, corrupt, or empty, restore from the newest backup
 * that actually contains list data. Returns true when a restore happened.
 */
function restoreIfNeeded(dataFile) {
  let current = null;
  let currentOk = false;
  try {
    if (fs.existsSync(dataFile)) {
      current = readJsonFile(dataFile);
      currentOk = hasListData(current);
    }
  } catch {
    currentOk = false;
  }
  if (currentOk) return false;

  const dir = backupDirFor(dataFile);
  for (const entry of listBackupFiles(dir)) {
    let parsed;
    try {
      parsed = readJsonFile(entry.full);
    } catch {
      continue;
    }
    if (!hasListData(parsed)) continue;
    try {
      fs.copyFileSync(entry.full, dataFile);
      console.log(`Restored data.json from local backup: ${entry.name}`);
      return true;
    } catch (err) {
      console.error("Failed to restore from backup:", entry.name, err.message);
    }
  }
  return false;
}

module.exports = { snapshotBeforeWrite, writeAtomic, restoreIfNeeded, hasListData };
