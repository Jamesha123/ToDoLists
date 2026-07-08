"use strict";

/**
 * Collaborative lists server.
 *
 * Zero external dependencies — it uses only Node.js built-in modules, so it
 * runs with `node server.js` (no `npm install` required).
 *
 * The app holds many named lists. Every list groups its items under subtopics
 * (categories). Grocery lists come with preset subtopics; any list can also
 * add its own custom subtopics. A memory of "past items" — things checked off
 * and then removed via "Clear completed" — is kept per list TYPE, so every
 * grocery list shares one memory and every to-do list shares another.
 *
 * Real-time collaboration uses Server-Sent Events (SSE): every browser opens a
 * long-lived `/api/events` stream, and whenever anything changes the server
 * pushes the new state to everyone. State is persisted to `data.json`.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const recipeParser = require("./recipe-parser");
const dataBackup = require("./data-backup");
const localBackup = require("./local-backup");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data.json");

const LIST_TYPES = ["todo", "groceries"];
const DEFAULT_TYPE = "todo";

// Preset grocery subtopics (excluding misc, which is universal + always last).
const GROCERY_PRESETS = ["produce", "bakery", "protein", "condiments", "pantry", "snacks", "beverages", "ava", "personal", "home"];
const PRESET_LABELS = {
  produce: "Produce",
  bakery: "Bakery",
  protein: "Protein",
  condiments: "Seasonings/Condiments",
  pantry: "Pantry",
  snacks: "Snacks",
  beverages: "Beverages",
  ava: "Ava",
  personal: "Personal Care",
  home: "Home Goods",
};
const DEFAULT_CATEGORY = "misc";

// Units for quantities. Conversions only make sense within a single dimension
// (you can't turn cups into apples, or fluid ounces into grams without knowing
// an ingredient's density). Each unit converts to a per-dimension base unit:
// count -> "each", volume -> milliliter, weight -> gram.
const UNITS = {
  each: { dim: "count", toBase: 1 },
  tsp: { dim: "volume", toBase: 4.92892 },
  tbsp: { dim: "volume", toBase: 14.7868 },
  floz: { dim: "volume", toBase: 29.5735 },
  cup: { dim: "volume", toBase: 236.588 },
  pt: { dim: "volume", toBase: 473.176 },
  qt: { dim: "volume", toBase: 946.353 },
  gal: { dim: "volume", toBase: 3785.41 },
  ml: { dim: "volume", toBase: 1 },
  l: { dim: "volume", toBase: 1000 },
  oz: { dim: "weight", toBase: 28.3495 },
  lb: { dim: "weight", toBase: 453.592 },
  g: { dim: "weight", toBase: 1 },
  kg: { dim: "weight", toBase: 1000 },
};

const round4 = (n) => Math.round(n * 10000) / 10000;

/** "chocolate milk" → "Chocolate Milk"; hyphenated words are capitalized per part. */
function titleCaseText(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : ""))
        .filter(Boolean)
        .join("-")
    )
    .join(" ");
}

/** Coerce arbitrary input into a valid { amount, unit } or null. */
function sanitizeQty(qty) {
  if (!qty || typeof qty !== "object") return null;
  const amount = Number(qty.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!UNITS[qty.unit]) return null;
  return { amount: round4(amount), unit: qty.unit };
}

/** Convert an amount between two units of the same dimension; null if incompatible. */
function convertAmount(amount, from, to) {
  if (from === to) return amount;
  const a = UNITS[from];
  const b = UNITS[to];
  if (!a || !b || a.dim !== b.dim) return null;
  return (amount * a.toBase) / b.toBase;
}

/** Combine two quantities for the same item, converting into base's unit. */
function mergeQty(base, extra) {
  if (!base) return extra || null;
  if (!extra) return base;
  const converted = convertAmount(extra.amount, extra.unit, base.unit);
  if (converted == null) return base; // different dimensions — keep base
  return { amount: round4(base.amount + converted), unit: base.unit };
}

// ---------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------

/** Newest activity kept in memory / on disk. */
const ACTIVITY_LIMIT = 200;
/** Entries older than this are dropped automatically. */
const ACTIVITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

localBackup.restoreIfNeeded(DATA_FILE);
let state = loadState();

/** One-time persist after title-casing legacy item text still on disk. */
(function persistTitleCaseMigration() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return;
  }
  let dirty = false;
  const needsFix = (text) => text && titleCaseText(text) !== text;
  for (const list of parsed.lists || []) {
    for (const it of list.items || []) {
      if (needsFix(it.text)) {
        dirty = true;
        break;
      }
    }
    if (dirty) break;
  }
  if (!dirty && parsed.remembered) {
    const buckets = Array.isArray(parsed.remembered) ? { groceries: parsed.remembered } : parsed.remembered;
    for (const bucket of Object.values(buckets)) {
      if (!Array.isArray(bucket)) continue;
      for (const r of bucket) {
        if (needsFix(r.name)) {
          dirty = true;
          break;
        }
      }
      if (dirty) break;
    }
  }
  if (!dirty) {
    for (const recipe of parsed.recipes || []) {
      for (const ing of recipe.ingredients || []) {
        if (needsFix(ing.text)) {
          dirty = true;
          break;
        }
      }
      if (dirty) break;
    }
  }
  if (!dirty) return;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to save title-case migration:", err);
  }
})();

/** Open SSE clients: Set of { res, id, name, listId } for live sync + presence. */
const clients = new Set();

/** Clean a display name from the client into something safe and bounded. */
function sanitizeName(raw) {
  const name = String(raw == null ? "" : raw)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return name || "Guest";
}

/** Who is making this request, from headers the client attaches to mutations. */
function actorOf(req) {
  const id = String(req.headers["x-actor-id"] || "").slice(0, 64);
  let name = "";
  try {
    name = decodeURIComponent(String(req.headers["x-actor-name"] || ""));
  } catch {
    name = String(req.headers["x-actor-name"] || "");
  }
  return { id, name: sanitizeName(name) };
}

/** Drop entries older than the retention window, then cap the total kept. */
function pruneActivity() {
  const cutoff = Date.now() - ACTIVITY_MAX_AGE_MS;
  state.activity = state.activity.filter((a) => a && a.ts >= cutoff);
  if (state.activity.length > ACTIVITY_LIMIT) {
    state.activity.splice(0, state.activity.length - ACTIVITY_LIMIT);
  }
}

/**
 * Append an entry to the shared activity feed. Call inside a commit()'s mutate
 * callback so it is saved and broadcast together with the change it describes.
 */
function logActivity(actor, list, action, detail) {
  state.activity.push({
    id: crypto.randomUUID(),
    ts: Date.now(),
    actorId: actor && actor.id ? actor.id : null,
    actorName: actor && actor.name ? actor.name : "Someone",
    listId: list ? list.id : null,
    listName: list ? list.name : null,
    action,
    detail: detail == null ? "" : String(detail),
  });
  pruneActivity();
}

/** Per-list undo/redo history (in memory only): JSON snapshots of items. */
const histories = new Map();
const HISTORY_LIMIT = 100;

function emptyMemory() {
  return { todo: [], groceries: [] };
}

/** Make sure a list has all the fields this version expects. */
function normalizeList(list) {
  if (!Array.isArray(list.customCategories)) list.customCategories = [];
  for (const it of list.items || []) {
    if (!("qty" in it)) it.qty = null;
    if (it.text) it.text = titleCaseText(it.text);
  }
  return list;
}

/** Normalize a recipe and its ingredients. */
function normalizeRecipe(r) {
  return {
    id: r.id || crypto.randomUUID(),
    name: String(r.name || "Untitled recipe"),
    createdAt: r.createdAt || Date.now(),
    ingredients: Array.isArray(r.ingredients)
      ? r.ingredients.map((i) => ({
          id: i.id || crypto.randomUUID(),
          text: titleCaseText(i.text || ""),
          category: i.category || DEFAULT_CATEGORY,
          qty: sanitizeQty(i.qty),
        }))
      : [],
  };
}

function loadState() {
  const remembered = emptyMemory();

  const upsert = (type, entry) => {
    if (!entry || !entry.key || !remembered[type]) return;
    const name = titleCaseText(entry.name);
    const existing = remembered[type].find((r) => r.key === entry.key);
    if (existing) {
      existing.name = name;
      existing.category = entry.category;
      if (entry.label) existing.label = entry.label;
    } else {
      remembered[type].push({
        key: entry.key,
        name,
        category: entry.category,
        label: entry.label || "",
      });
    }
  };

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    if (Array.isArray(parsed.lists)) {
      for (const list of parsed.lists) {
        normalizeList(list);
        // Fold any older per-list remembered arrays into the type buckets.
        if (Array.isArray(list.remembered)) {
          const type = list.type === "groceries" ? "groceries" : "todo";
          for (const r of list.remembered) upsert(type, r);
          delete list.remembered;
        }
      }
      // Even older global remembered array → grocery bucket.
      if (Array.isArray(parsed.remembered)) for (const r of parsed.remembered) upsert("groceries", r);
      // Current per-type format.
      if (parsed.remembered && !Array.isArray(parsed.remembered)) {
        for (const type of LIST_TYPES) {
          if (Array.isArray(parsed.remembered[type])) for (const r of parsed.remembered[type]) upsert(type, r);
        }
      }
      const recipes = Array.isArray(parsed.recipes) ? parsed.recipes.map(normalizeRecipe) : [];

      // Build the shared grocery subtopic catalog from any saved catalog plus
      // every grocery list's existing custom subtopics.
      const grocerySubtopics = [];
      const addSub = (key, label) => {
        if (key && !grocerySubtopics.some((s) => s.key === key)) grocerySubtopics.push({ key, label: String(label || key) });
      };
      if (Array.isArray(parsed.grocerySubtopics)) for (const s of parsed.grocerySubtopics) if (s) addSub(s.key, s.label);
      for (const list of parsed.lists) {
        if (list.type === "groceries") for (const c of list.customCategories || []) addSub(c.key, c.label);
      }

      const cutoff = Date.now() - ACTIVITY_MAX_AGE_MS;
      const activity = (Array.isArray(parsed.activity) ? parsed.activity : [])
        .filter((a) => a && a.ts >= cutoff)
        .slice(-ACTIVITY_LIMIT);

      return { lists: parsed.lists, remembered, recipes, grocerySubtopics, activity };
    }

    if (Array.isArray(parsed.todos)) {
      return {
        lists: [
          normalizeList({
            id: crypto.randomUUID(),
            name: "My Tasks",
            type: DEFAULT_TYPE,
            createdAt: Date.now(),
            items: parsed.todos,
          }),
        ],
        remembered,
        recipes: [],
        grocerySubtopics: [],
        activity: [],
      };
    }
  } catch {
    // No file yet, or unreadable — start fresh.
  }
  return { lists: [], remembered, recipes: [], grocerySubtopics: [], activity: [] };
}

let saveTimer = null;

function diskPayload() {
  return {
    lists: state.lists,
    remembered: state.remembered,
    recipes: state.recipes,
    grocerySubtopics: state.grocerySubtopics,
    activity: state.activity,
    _savedAt: Date.now(),
  };
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const payload = diskPayload();
    const json = JSON.stringify(payload, null, 2);
    try {
      localBackup.snapshotBeforeWrite(DATA_FILE);
      localBackup.writeAtomic(DATA_FILE, json);
      dataBackup.schedule(json, payload._savedAt);
    } catch (err) {
      console.error("Failed to save data.json:", err);
    }
  }, 150);
}

/** On Render: use GitHub if its copy is newer than the file from the last deploy. */
async function restoreFromCloudIfNewer() {
  if (!dataBackup.configured()) return;
  const remote = await dataBackup.fetchRemote();
  if (!remote || !remote.data) return;

  let local = null;
  let localSavedAt = 0;
  try {
    local = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    localSavedAt = Number(local._savedAt) || 0;
  } catch {
    /* no local file yet */
  }

  const localHasData = localBackup.hasListData(local);
  const remoteHasData = localBackup.hasListData(remote.data);

  // Never replace real lists with an empty GitHub backup.
  if (!remoteHasData && localHasData) return;
  // Local is empty but GitHub has lists — always take GitHub.
  if (remoteHasData && !localHasData) {
    localBackup.snapshotBeforeWrite(DATA_FILE);
    localBackup.writeAtomic(DATA_FILE, JSON.stringify(remote.data, null, 2));
    state = loadState();
    console.log("Restored data.json from GitHub (local was empty)");
    return;
  }
  // Both have data — use whichever was saved more recently.
  if (remoteHasData && localHasData && remote.savedAt > localSavedAt) {
    localBackup.snapshotBeforeWrite(DATA_FILE);
    localBackup.writeAtomic(DATA_FILE, JSON.stringify(remote.data, null, 2));
    state = loadState();
    console.log("Restored data.json from GitHub (newer than deploy copy)");
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function makeCategoryKey(label) {
  const slug = String(label)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `c-${slug}` : "";
}

function isValidCategory(list, key) {
  if (!key) return false;
  if (key === DEFAULT_CATEGORY) return true;
  if (list.type === "groceries" && GROCERY_PRESETS.includes(key)) return true;
  return list.customCategories.some((c) => c.key === key);
}

function categoryLabelFor(list, key) {
  if (key === DEFAULT_CATEGORY) return "Miscellaneous";
  const custom = list.customCategories.find((c) => c.key === key);
  if (custom) return custom.label;
  if (PRESET_LABELS[key]) return PRESET_LABELS[key];
  return key;
}

/**
 * Resolve a requested category to a valid one for this list. If it's a custom
 * subtopic the list doesn't have yet but a label is supplied, recreate it here
 * so a remembered item's subtopic travels with it across lists.
 */
function resolveCategory(list, key, label) {
  if (isValidCategory(list, key)) return key;
  if (typeof key === "string" && key.startsWith("c-") && label && String(label).trim()) {
    if (!list.customCategories.some((c) => c.key === key)) {
      list.customCategories.push({ key, label: String(label).trim() });
    }
    return key;
  }
  return DEFAULT_CATEGORY;
}

/**
 * A shared catalog of grocery subtopics, so a subtopic created in any grocery
 * list (or in a recipe) is offered everywhere recipes are built.
 */
function addGrocerySubtopic(label) {
  const key = makeCategoryKey(label);
  if (!key) return "";
  if (!state.grocerySubtopics.some((s) => s.key === key)) {
    state.grocerySubtopics.push({ key, label: String(label).trim() });
  }
  return key;
}

function grocerySubtopicLabel(key) {
  if (key === DEFAULT_CATEGORY) return "Miscellaneous";
  if (PRESET_LABELS[key]) return PRESET_LABELS[key];
  const c = state.grocerySubtopics.find((s) => s.key === key);
  return c ? c.label : key;
}

// ---------------------------------------------------------------------------
// Undo / redo history
// ---------------------------------------------------------------------------

function getHistory(id) {
  let h = histories.get(id);
  if (!h) {
    h = { undo: [], redo: [] };
    histories.set(id, h);
  }
  return h;
}

function recordHistory(list) {
  const h = getHistory(list.id);
  h.undo.push(JSON.stringify(list.items));
  if (h.undo.length > HISTORY_LIMIT) h.undo.shift();
  h.redo.length = 0;
}

// ---------------------------------------------------------------------------
// Remembered ("past") items — shared per list type
// ---------------------------------------------------------------------------

function singularize(word) {
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/oes$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

function normalizeKey(name) {
  const clean = String(name).toLowerCase().trim().replace(/\s+/g, " ");
  if (!clean) return "";
  const tokens = clean.split(" ");
  tokens[tokens.length - 1] = singularize(tokens[tokens.length - 1]);
  return tokens.join(" ");
}

function rememberItem(list, name, category) {
  const cat = isValidCategory(list, category) ? category : DEFAULT_CATEGORY;
  upsertMemory(list.type, name, cat, categoryLabelFor(list, cat));
}

/** Upsert an entry into a memory bucket, deduped by (plural-insensitive) key. */
function upsertMemory(type, name, category, label) {
  const display = titleCaseText(name);
  const key = normalizeKey(display);
  if (!key) return;
  const bucket = state.remembered[type] || (state.remembered[type] = []);
  const existing = bucket.find((r) => r.key === key);
  if (existing) {
    existing.name = display;
    existing.category = category;
    existing.label = label || "";
  } else {
    bucket.push({ key, name: display, category, label: label || "" });
  }
}

/**
 * When a recipe ingredient is edited, keep the grocery memory in sync: if the
 * item was remembered (matched by its previous name), update it — rekeying and
 * merging if the name changed.
 */
function reflectEditInMemory(oldName, name, category) {
  const bucket = state.remembered.groceries;
  if (!bucket) return;
  const oldKey = normalizeKey(oldName);
  if (!bucket.some((r) => r.key === oldKey)) return; // wasn't remembered
  state.remembered.groceries = bucket.filter((r) => r.key !== oldKey);
  upsertMemory("groceries", name, category, grocerySubtopicLabel(category));
}

// ---------------------------------------------------------------------------
// Real-time broadcast
// ---------------------------------------------------------------------------

function publicState() {
  return {
    lists: state.lists.map((l) => {
      const h = histories.get(l.id);
      return { ...l, canUndo: !!(h && h.undo.length), canRedo: !!(h && h.redo.length) };
    }),
    remembered: state.remembered,
    recipes: state.recipes,
    grocerySubtopics: state.grocerySubtopics,
    activity: state.activity,
  };
}

function serialize() {
  return `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
}

function broadcast() {
  const payload = serialize();
  for (const c of clients) c.res.write(payload);
}

/** One entry per open connection; the client dedupes by id for user counts. */
function presenceList() {
  return Array.from(clients).map((c) => ({ id: c.id, name: c.name, listId: c.listId || null }));
}

function serializePresence() {
  return `event: presence\ndata: ${JSON.stringify(presenceList())}\n\n`;
}

function broadcastPresence() {
  const payload = serializePresence();
  for (const c of clients) c.res.write(payload);
}

function commit(mutate) {
  mutate();
  saveState();
  broadcast();
}

const findList = (id) => state.lists.find((l) => l.id === id);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.join(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

function handleEvents(req, res, url) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(serialize());

  const client = {
    res,
    id: (url.searchParams.get("id") || crypto.randomUUID()).slice(0, 64),
    name: sanitizeName(url.searchParams.get("name")),
    listId: url.searchParams.get("listId") || null,
  };
  clients.add(client);
  broadcastPresence();

  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(client);
    broadcastPresence();
  });
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

function makeItem(list, text, category, label, qty) {
  return {
    id: crypto.randomUUID(),
    text: titleCaseText(text),
    done: false,
    createdAt: Date.now(),
    category: resolveCategory(list, category, label),
    qty: sanitizeQty(qty),
  };
}

/**
 * Add an item to a list, merging into an existing item with the same
 * (plural-insensitive) name. Quantities are summed when their units are
 * compatible; incompatible dimensions fall back to a separate line.
 */
function addOrMerge(list, it) {
  const key = normalizeKey(it.text);
  const existing = key ? list.items.find((x) => normalizeKey(x.text) === key) : null;
  if (!existing) {
    list.items.push(makeItem(list, it.text, it.category, it.label, it.qty));
    return;
  }
  const incompatible =
    existing.qty && it.qty && convertAmount(it.qty.amount, it.qty.unit, existing.qty.unit) == null;
  if (incompatible) {
    list.items.push(makeItem(list, it.text, it.category, it.label, it.qty));
  } else {
    existing.qty = mergeQty(existing.qty, it.qty);
  }
}

/**
 * Add a single item via the normal add flow. If no quantity is given, a repeat
 * add of a count-type item on a grocery list bumps its count (1 → 2 → 3 …)
 * instead of creating a duplicate row. An explicit quantity merges as usual.
 */
function addSingle(list, text, category, label, qty) {
  const name = titleCaseText(text);
  const clean = sanitizeQty(qty);
  if (clean) return addOrMerge(list, { text: name, category, label, qty: clean });

  if (list.type === "groceries") {
    const key = normalizeKey(name);
    const existing = key ? list.items.find((x) => normalizeKey(x.text) === key) : null;
    if (existing) {
      if (!existing.qty) {
        existing.qty = { amount: 2, unit: "each" }; // first add was an implicit 1
      } else if (UNITS[existing.qty.unit] && UNITS[existing.qty.unit].dim === "count") {
        existing.qty = { amount: round4(existing.qty.amount + 1), unit: existing.qty.unit };
      }
      // Non-count quantities (volume/weight) are left as-is — no duplicate row.
      return;
    }
  }

  list.items.push(makeItem(list, name, category, label, null));
}

async function handleRecipes(req, res, parts) {
  const recipeId = parts[2];
  const sub = parts[3];

  // ---- Collection: /api/recipes ----------------------------------------
  if (!recipeId) {
    if (req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (!name) return sendJSON(res, 400, { error: "Name is required" });
      const recipe = normalizeRecipe({ name });
      commit(() => state.recipes.push(recipe));
      return sendJSON(res, 201, { ok: true, id: recipe.id });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }

  // ---- Parse: extract ingredients from a URL or pasted text ------------
  if (recipeId === "parse") {
    if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });
    const body = await readBody(req);
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const text = typeof body.text === "string" ? body.text : "";

    let parsed;
    try {
      if (url) parsed = await recipeParser.importFromUrl(url);
      else if (text.trim()) parsed = recipeParser.parseRecipeText(text, "");
      else return sendJSON(res, 400, { error: "Paste a recipe URL or some recipe text." });
    } catch (err) {
      return sendJSON(res, 400, { error: err.message || "Couldn't read that recipe." });
    }

    const ingredients = (parsed.ingredients || []).filter((i) => i && i.text);
    if (!ingredients.length) {
      return sendJSON(res, 422, { error: "No ingredients found. Try pasting the ingredient list." });
    }
    return sendJSON(res, 200, {
      ok: true,
      name: parsed.name || "",
      ingredients: ingredients.map((i) => ({
        text: titleCaseText(i.text),
        category: DEFAULT_CATEGORY,
        qty: i.qty,
      })),
    });
  }

  const recipe = state.recipes.find((r) => r.id === recipeId);
  if (!recipe) return sendJSON(res, 404, { error: "Recipe not found" });

  // ---- A single recipe -------------------------------------------------
  if (!sub) {
    if (req.method === "PATCH") {
      const body = await readBody(req);
      commit(() => {
        if (typeof body.name === "string" && body.name.trim()) recipe.name = body.name.trim();
      });
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      commit(() => {
        state.recipes = state.recipes.filter((r) => r.id !== recipeId);
      });
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }

  // ---- Save: push all ingredients into grocery memory (deduped) ---------
  if (sub === "save") {
    if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });
    commit(() => {
      for (const ing of recipe.ingredients) {
        const cat = ing.category || DEFAULT_CATEGORY;
        upsertMemory("groceries", ing.text, cat, grocerySubtopicLabel(cat));
      }
    });
    return sendJSON(res, 200, { ok: true });
  }

  if (sub !== "ingredients") return sendJSON(res, 404, { error: "Unknown endpoint" });

  // ---- Ingredients -----------------------------------------------------
  const makeIngredient = (b) => ({
    id: crypto.randomUUID(),
    text: titleCaseText(b.text || ""),
    category: typeof b.category === "string" ? b.category : DEFAULT_CATEGORY,
    qty: sanitizeQty(b.qty),
  });

  const seg = parts[4];

  if (req.method === "POST" && seg === "batch") {
    const body = await readBody(req);
    const incoming = Array.isArray(body.items) ? body.items : [];
    const toAdd = incoming.map(makeIngredient).filter((i) => i.text);
    if (!toAdd.length) return sendJSON(res, 400, { error: "No ingredients to add" });
    commit(() => {
      for (const i of toAdd) recipe.ingredients.push(i);
    });
    return sendJSON(res, 201, { ok: true });
  }

  // Replace the whole ingredient list (used when saving buffered edits).
  if (req.method === "PUT" && !seg) {
    const body = await readBody(req);
    const incoming = Array.isArray(body.items) ? body.items : [];
    const next = incoming.map(makeIngredient).filter((i) => i.text);
    commit(() => {
      recipe.ingredients = next;
    });
    return sendJSON(res, 200, { ok: true });
  }

  const ingId = seg && seg !== "batch" ? seg : undefined;

  if (req.method === "POST" && !ingId) {
    const body = await readBody(req);
    const ing = makeIngredient(body);
    if (!ing.text) return sendJSON(res, 400, { error: "Ingredient text is required" });
    commit(() => recipe.ingredients.push(ing));
    return sendJSON(res, 201, { ok: true });
  }

  if (req.method === "PATCH" && ingId) {
    const body = await readBody(req);
    const ing = recipe.ingredients.find((i) => i.id === ingId);
    if (!ing) return sendJSON(res, 404, { error: "Ingredient not found" });
    const oldName = ing.text;
    commit(() => {
      if (typeof body.text === "string" && body.text.trim()) ing.text = titleCaseText(body.text);
      if (typeof body.category === "string") ing.category = body.category;
      if ("qty" in body) ing.qty = sanitizeQty(body.qty);
      // Keep the grocery memory in sync with edits to remembered items.
      reflectEditInMemory(oldName, ing.text, ing.category || DEFAULT_CATEGORY);
    });
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && ingId) {
    commit(() => {
      recipe.ingredients = recipe.ingredients.filter((i) => i.id !== ingId);
    });
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 405, { error: "Method not allowed" });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "lists", ...]
  const actor = actorOf(req);

  if (parts[1] === "backup") {
    const sub = parts[2] || "";
    if (req.method === "GET" && !sub) {
      return sendJSON(res, 200, { ok: true, github: dataBackup.status ? dataBackup.status() : { configured: false } });
    }
    if (req.method === "POST" && sub === "flush") {
      await dataBackup.flush();
      return sendJSON(res, 200, { ok: true, github: dataBackup.status ? dataBackup.status() : { configured: false } });
    }
    if (req.method === "GET" && sub === "remote") {
      const remote = await dataBackup.fetchRemote();
      if (!remote) return sendJSON(res, 200, { ok: true, remote: null });
      return sendJSON(res, 200, { ok: true, remote: { savedAt: remote.savedAt, sha: remote.sha } });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }

  if (parts[1] === "recipes") return handleRecipes(req, res, parts);
  if (parts[1] === "activity") {
    if (req.method === "DELETE") {
      commit(() => {
        state.activity = [];
      });
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }
  if (parts[1] === "presence") {
    // Update which list a connected client is viewing (and their name).
    if (req.method === "POST") {
      const body = await readBody(req);
      const id = String(body.id || "");
      const name = sanitizeName(body.name);
      const listId = body.listId || null;
      let changed = false;
      for (const c of clients) {
        if (c.id !== id) continue;
        if (c.name !== name || c.listId !== listId) {
          c.name = name;
          c.listId = listId;
          changed = true;
        }
      }
      if (changed) broadcastPresence();
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }
  if (parts[1] === "subtopics") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const label = String(body.label || "").trim();
      const key = makeCategoryKey(label);
      if (!label || !key) return sendJSON(res, 400, { error: "A subtopic name is required" });
      commit(() => addGrocerySubtopic(label));
      return sendJSON(res, 201, { ok: true, key });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }
  if (parts[1] !== "lists") return sendJSON(res, 404, { error: "Unknown endpoint" });

  const listId = parts[2];
  const sub = parts[3];

  // ---- Collection: /api/lists ------------------------------------------
  if (!listId) {
    if (req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const type = LIST_TYPES.includes(body.type) ? body.type : DEFAULT_TYPE;
      if (!name) return sendJSON(res, 400, { error: "Name is required" });
      const list = normalizeList({ id: crypto.randomUUID(), name, type, createdAt: Date.now(), items: [] });
      commit(() => {
        state.lists.push(list);
        logActivity(actor, list, "createList", list.name);
      });
      return sendJSON(res, 201, { ok: true, id: list.id });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }

  const list = findList(listId);
  if (!list) return sendJSON(res, 404, { error: "List not found" });

  // ---- Undo / redo -----------------------------------------------------
  if (sub === "undo" || sub === "redo") {
    if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" });
    const h = getHistory(list.id);
    const from = sub === "undo" ? h.undo : h.redo;
    const to = sub === "undo" ? h.redo : h.undo;
    if (from.length) {
      commit(() => {
        to.push(JSON.stringify(list.items));
        list.items = JSON.parse(from.pop());
      });
    }
    return sendJSON(res, 200, { ok: true });
  }

  // ---- Custom categories -----------------------------------------------
  if (sub === "categories") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const label = String(body.label || "").trim();
      const key = makeCategoryKey(label);
      if (!label || !key) return sendJSON(res, 400, { error: "A subtopic name is required" });
      commit(() => {
        if (!list.customCategories.some((c) => c.key === key)) list.customCategories.push({ key, label });
        if (list.type === "groceries") addGrocerySubtopic(label);
      });
      return sendJSON(res, 201, { ok: true, key });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }

  // ---- Remembered items (per type, addressed via the list) -------------
  if (sub === "remembered") {
    const key = parts[4] ? decodeURIComponent(parts[4]) : null;
    if (req.method === "DELETE" && key) {
      commit(() => {
        const bucket = state.remembered[list.type];
        if (bucket) state.remembered[list.type] = bucket.filter((r) => r.key !== key);
      });
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }

  // ---- A single list ---------------------------------------------------
  if (!sub) {
    if (req.method === "PATCH") {
      const body = await readBody(req);
      commit(() => {
        const renamed = typeof body.name === "string" && body.name.trim() && body.name.trim() !== list.name;
        if (typeof body.name === "string" && body.name.trim()) list.name = body.name.trim();
        if (LIST_TYPES.includes(body.type)) list.type = body.type;
        if (renamed) logActivity(actor, list, "renameList", list.name);
      });
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      const removed = list.name;
      commit(() => {
        state.lists = state.lists.filter((l) => l.id !== listId);
        logActivity(actor, null, "deleteList", removed);
      });
      histories.delete(listId);
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: "Method not allowed" });
  }

  if (sub !== "items") return sendJSON(res, 404, { error: "Unknown endpoint" });

  // ---- Items -----------------------------------------------------------
  const seg = parts[4];

  if (req.method === "POST" && seg === "batch") {
    const body = await readBody(req);
    const incoming = Array.isArray(body.items) ? body.items : [];
    const toAdd = incoming
      .map((it) => ({
        text: titleCaseText(it.text || ""),
        category: it.category,
        label: it.label,
        qty: sanitizeQty(it.qty),
      }))
      .filter((it) => it.text);
    if (!toAdd.length) return sendJSON(res, 400, { error: "No items to add" });
    recordHistory(list);
    commit(() => {
      for (const it of toAdd) addSingle(list, it.text, it.category, it.label, it.qty);
      const detail =
        toAdd.length === 1 ? toAdd[0].text : `${toAdd.length} items (${toAdd.map((t) => t.text).join(", ")})`;
      logActivity(actor, list, "add", detail);
    });
    return sendJSON(res, 201, { ok: true });
  }

  const itemId = seg && seg !== "batch" ? seg : undefined;

  if (req.method === "POST" && !itemId) {
    const body = await readBody(req);
    const text = titleCaseText(body.text || "");
    if (!text) return sendJSON(res, 400, { error: "Text is required" });
    recordHistory(list);
    commit(() => {
      addSingle(list, text, body.category, body.label, body.qty);
      logActivity(actor, list, "add", text);
    });
    return sendJSON(res, 201, { ok: true });
  }

  if (req.method === "DELETE" && !itemId) {
    const all = url.searchParams.get("scope") === "all";
    recordHistory(list);
    commit(() => {
      if (all) {
        const n = list.items.length;
        list.items = [];
        logActivity(actor, list, "clearAll", `${n} item${n === 1 ? "" : "s"}`);
      } else {
        const done = list.items.filter((t) => t.done);
        for (const it of done) rememberItem(list, it.text, it.category);
        list.items = list.items.filter((t) => !t.done);
        logActivity(actor, list, "clearDone", `${done.length} completed`);
      }
    });
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === "PATCH" && itemId) {
    const body = await readBody(req);
    const item = list.items.find((t) => t.id === itemId);
    if (!item) return sendJSON(res, 404, { error: "Item not found" });
    recordHistory(list);
    const before = item.text;
    commit(() => {
      const toggled = typeof body.done === "boolean" && body.done !== item.done;
      const willBeDone = body.done;
      const renamed = typeof body.text === "string" && body.text.trim() && body.text.trim() !== item.text;
      if (typeof body.done === "boolean") item.done = body.done;
      if (typeof body.text === "string" && body.text.trim()) item.text = titleCaseText(body.text);
      if (isValidCategory(list, body.category)) item.category = body.category;
      if ("qty" in body) item.qty = sanitizeQty(body.qty);

      // Prefer the most meaningful single description of this change.
      if (renamed) {
        logActivity(actor, list, "edit", `${before} → ${item.text}`);
      } else if (toggled) {
        logActivity(actor, list, willBeDone ? "check" : "uncheck", item.text);
      } else {
        logActivity(actor, list, "edit", item.text);
      }
    });
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && itemId) {
    const victim = list.items.find((t) => t.id === itemId);
    recordHistory(list);
    commit(() => {
      list.items = list.items.filter((t) => t.id !== itemId);
      if (victim) logActivity(actor, list, "delete", victim.text);
    });
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 405, { error: "Method not allowed" });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/events") return handleEvents(req, res, url);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res);
  } catch (err) {
    sendJSON(res, 400, { error: err.message || "Bad request" });
  }
});

(async function boot() {
  await restoreFromCloudIfNewer();
  server.listen(PORT, () => {
    console.log(`Collaborative lists running at http://localhost:${PORT}`);
    if (dataBackup.configured()) console.log("GitHub data backup enabled");
  });
})();

process.on("SIGTERM", () => {
  dataBackup.flush().finally(() => process.exit(0));
});
