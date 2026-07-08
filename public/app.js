"use strict";

// ---------------------------------------------------------------------------
// Collaborative lists — client.
//
// The server holds many named lists and pushes the full set over Server-Sent
// Events (/api/events). Every list groups its items under subtopics. Grocery
// lists get preset subtopics; any list can add its own custom subtopics. A
// "past items" memory (things checked off and then cleared) is shared per list
// type — every grocery list shares one memory, every to-do list another — and
// items can be re-added from a modal.
//
//   #/             -> home: the list of lists
//   #/list/<id>    -> detail: the items inside one list
// ---------------------------------------------------------------------------

const TYPE_META = {
  todo: { label: "To-do", icon: "📝" },
  groceries: { label: "Groceries", icon: "🛒" },
};

// Preset grocery subtopics (excluding misc), in display order.
const GROCERY_PRESETS = [
  ["produce", "Produce"],
  ["bakery", "Bakery"],
  ["protein", "Protein"],
  ["condiments", "Seasonings/Condiments"],
  ["pantry", "Pantry"],
  ["snacks", "Snacks"],
  ["beverages", "Beverages"],
  ["ava", "Ava"],
  ["personal", "Personal Care"],
  ["home", "Home Goods"],
];
const PRESET_LABEL = Object.fromEntries(GROCERY_PRESETS);
const MISC = "misc";
const NEW_CAT = "__new__";

// --- units (mirror of the server) -------------------------------------------

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

const UNIT_LABEL = {
  each: "each",
  tsp: "tsp",
  tbsp: "tbsp",
  floz: "fl oz",
  cup: "cup",
  pt: "pint",
  qt: "quart",
  gal: "gallon",
  ml: "ml",
  l: "L",
  oz: "oz",
  lb: "lb",
  g: "g",
  kg: "kg",
};

const UNIT_GROUPS = [
  ["Count", ["each"]],
  ["Volume", ["tsp", "tbsp", "floz", "cup", "pt", "qt", "gal", "ml", "l"]],
  ["Weight", ["oz", "lb", "g", "kg"]],
];

const roundNice = (n) => Math.round(n * 1000) / 1000;

function convertAmount(amount, from, to) {
  if (from === to) return amount;
  const a = UNITS[from];
  const b = UNITS[to];
  if (!a || !b || a.dim !== b.dim) return null; // can't cross dimensions
  return (amount * a.toBase) / b.toBase;
}

function formatQty(qty) {
  if (!qty) return "";
  const amt = roundNice(qty.amount);
  return qty.unit === "each" ? `×${amt}` : `${amt} ${UNIT_LABEL[qty.unit] || qty.unit}`;
}

function fillUnitSelect(sel, selected) {
  sel.innerHTML = "";
  for (const [group, keys] of UNIT_GROUPS) {
    const og = document.createElement("optgroup");
    og.label = group;
    for (const k of keys) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = UNIT_LABEL[k];
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = selected && UNITS[selected] ? selected : "each";
  sel.dataset.prev = sel.value;
}

function buildUnitSelect(selected) {
  const sel = document.createElement("select");
  sel.className = "qty__unit";
  fillUnitSelect(sel, selected);
  return sel;
}

/** Wire live unit conversion between a unit <select> and an amount <input>. */
function wireConverter(unitSel, amountInput) {
  unitSel.addEventListener("change", () => {
    const prev = unitSel.dataset.prev;
    const cur = unitSel.value;
    const val = Number(amountInput.value);
    if (amountInput.value !== "" && Number.isFinite(val)) {
      const conv = convertAmount(val, prev, cur);
      if (conv != null) amountInput.value = roundNice(conv);
    }
    unitSel.dataset.prev = cur;
  });
}

/**
 * Amount input + unit select. Changing the unit converts the amount in place
 * (within the same dimension) — this is the live measurement converter.
 * Returns { wrap, amount, unit, read } where read() -> {amount, unit} | null.
 */
function buildQtyControls(qty) {
  const wrap = document.createElement("div");
  wrap.className = "qty";

  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "any";
  amount.className = "qty__amount";
  amount.placeholder = "—";
  if (qty) amount.value = roundNice(qty.amount);

  const unit = buildUnitSelect(qty ? qty.unit : "each");
  wireConverter(unit, amount);

  wrap.append(amount, unit);

  const read = () => {
    const a = Number(amount.value);
    if (amount.value === "" || !Number.isFinite(a) || a <= 0) return null;
    return { amount: a, unit: unit.value };
  };

  return { wrap, amount, unit, read };
}

/**
 * Ordered [key, label] catalog for recipe ingredients: grocery presets, then
 * every shared custom subtopic, then Miscellaneous. Any subtopic added in a
 * grocery list (or a recipe) shows up here.
 */
function recipeCatalog() {
  const out = [...GROCERY_PRESETS];
  const seen = new Set(out.map(([k]) => k));
  for (const s of grocerySubtopics) {
    if (!seen.has(s.key)) {
      out.push([s.key, s.label]);
      seen.add(s.key);
    }
  }
  out.push([MISC, "Miscellaneous"]);
  return out;
}

function catalogLabel(key) {
  const found = recipeCatalog().find(([k]) => k === key);
  return found ? found[1] : key;
}

function fillRecipeCatSelect(sel, selected, includeNew) {
  sel.innerHTML = "";
  for (const [key, label] of recipeCatalog()) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = label;
    sel.appendChild(o);
  }
  if (includeNew) {
    const nw = document.createElement("option");
    nw.value = NEW_CAT;
    nw.textContent = "➕ New subtopic…";
    sel.appendChild(nw);
  }
  sel.value = recipeCatalog().some(([k]) => k === selected) ? selected : MISC;
}

let lists = [];
let memory = { todo: [], groceries: [] };
let recipes = [];
let loaded = false;
let editingId = null;
let activeDrag = null;

// List detail view has a read-only "view" mode and an "edit" mode (like recipes).
// Editing reveals the add form plus the Past items / Recipes / Clear all actions.
let listEditing = false;
let detailShownId = null;
let pastOpen = false;
const pastSelected = new Set();

// Where the Past-items modal adds selections: a list, or a recipe being built.
let pastTarget = { kind: "list" };

// Recipe modal state.
let recipeOpenId = null;
let recipeDestId = null;
let editingIngId = null;
let pendingIngAddCat = null;
const recipeSelected = new Set();

// Edit mode buffers changes so they can be Saved or Discarded as a unit.
let recipeEditing = false;
let draftIngredients = null;
let draftName = null;
let tmpSeq = 0;
const tmpId = () => `tmp-${++tmpSeq}`;

// Shared grocery subtopic catalog (from the server) used to build recipes.
let grocerySubtopics = [];

// Pending selections so an in-progress "new subtopic" survives a re-render.
let pendingAddCategory = null;
let pendingEditCategory = null;
let pendingEditText = null;

// --- category helpers --------------------------------------------------------

/** Ordered [key, label] subtopics for a list: presets + custom + misc last. */
function categoriesFor(list) {
  const out = [];
  if (list.type === "groceries") for (const pair of GROCERY_PRESETS) out.push(pair);
  for (const c of list.customCategories || []) out.push([c.key, c.label]);
  out.push([MISC, "Miscellaneous"]);
  return out;
}

function categoryLabel(list, key) {
  if (key === MISC) return "Miscellaneous";
  const custom = (list.customCategories || []).find((c) => c.key === key);
  if (custom) return custom.label;
  if (PRESET_LABEL[key]) return PRESET_LABEL[key];
  return key;
}

const categoryOf = (item) => item.category || MISC;

/** Mirror of the server's custom-category key derivation. */
function predictKey(label) {
  const slug = String(label)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `c-${slug}` : "";
}

// --- element refs -----------------------------------------------------------

const el = (id) => document.getElementById(id);

const statusEl = el("status");
const statusText = el("statusText");
const presenceEl = el("presence");
const detailViewers = el("detailViewers");
const activityBtn = el("activityBtn");
const activityBadge = el("activityBadge");
const activityModal = el("activityModal");
const activityBackdrop = el("activityBackdrop");
const activityClose = el("activityClose");
const activityClear = el("activityClear");
const activityMarkRead = el("activityMarkRead");
const activityBody = el("activityBody");
const homeView = el("homeView");
const detailView = el("detailView");
const listsEl = el("lists");
const listsHint = el("listsHint");

const newListBtn = el("newListBtn");
const newListPanel = el("newListPanel");
const newListName = el("newListName");
const newListType = el("newListType");
const newListCreate = el("newListCreate");
const newListCancel = el("newListCancel");

const backBtn = el("backBtn");
const detailTitle = el("detailTitle");
const detailBadge = el("detailBadge");
const addForm = el("addForm");
const addInput = el("addInput");
const addCategory = el("addCategory");
const itemsEl = el("items");
const countEl = el("count");
const clearDoneBtn = el("clearDone");
const clearAllBtn = el("clearAll");
const undoBtn = el("undoBtn");
const redoBtn = el("redoBtn");
const pastBtn = el("pastBtn");
const editListBtn = el("editListBtn");

const pastModal = el("pastModal");
const pastBackdrop = el("pastBackdrop");
const pastClose = el("pastClose");
const pastBody = el("pastBody");
const pastBar = el("pastBar");
const pastBarCount = el("pastBarCount");
const pastAdd = el("pastAdd");

const recipesBtn = el("recipesBtn");
const recipesModal = el("recipesModal");
const recipesBackdrop = el("recipesBackdrop");
const recipesClose = el("recipesClose");
const recipesListEl = el("recipesList");
const newRecipeForm = el("newRecipeForm");
const newRecipeName = el("newRecipeName");
const recipeImportToggle = el("recipeImportToggle");
const recipeImportForm = el("recipeImportForm");
const importUrl = el("importUrl");
const importText = el("importText");
const importSubmit = el("importSubmit");
const importStatus = el("importStatus");

const recipeModal = el("recipeModal");
const recipeBackdrop = el("recipeBackdrop");
const recipeBack = el("recipeBack");
const recipeClose = el("recipeClose");
const recipeName = el("recipeName");
const recipeEditBtn = el("recipeEditBtn");
const recipeEditControls = el("recipeEditControls");
const recipeViewFoot = el("recipeViewFoot");
const recipeEditFoot = el("recipeEditFoot");
const recipeSave = el("recipeSave");
const recipeDiscard = el("recipeDiscard");
const ingAddForm = el("ingAddForm");
const ingText = el("ingText");
const ingCategory = el("ingCategory");
const ingAmount = el("ingAmount");
const ingUnit = el("ingUnit");
const ingFromPast = el("ingFromPast");
const ingList = el("ingList");
const recipeDest = el("recipeDest");
const recipeAddToList = el("recipeAddToList");
const recipeSelCount = el("recipeSelCount");
const recipeDelete = el("recipeDelete");

// --- API --------------------------------------------------------------------

async function api(method, url, body) {
  const headers = {
    "x-actor-id": myId,
    "x-actor-name": encodeURIComponent(myName || "Guest"),
  };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) console.error(`${method} ${url} -> ${res.status}`);
  return res;
}

const createList = (name, type) => api("POST", "/api/lists", { name, type });
const deleteList = (id) => api("DELETE", `/api/lists/${id}`);
const addItem = (listId, text, category) => api("POST", `/api/lists/${listId}/items`, { text, category });
const patchItem = (listId, id, patch) => api("PATCH", `/api/lists/${listId}/items/${id}`, patch);
const removeItem = (listId, id) => api("DELETE", `/api/lists/${listId}/items/${id}`);
const clearCompleted = (listId) => api("DELETE", `/api/lists/${listId}/items`);
const clearAll = (listId) => api("DELETE", `/api/lists/${listId}/items?scope=all`);
const undo = (listId) => api("POST", `/api/lists/${listId}/undo`);
const redo = (listId) => api("POST", `/api/lists/${listId}/redo`);
const batchAdd = (listId, items) => api("POST", `/api/lists/${listId}/items/batch`, { items });
const createCategory = (listId, label) => api("POST", `/api/lists/${listId}/categories`, { label });
const clearActivity = () => api("DELETE", "/api/activity");
const forgetItem = (listId, key) => api("DELETE", `/api/lists/${listId}/remembered/${encodeURIComponent(key)}`);

const createRecipe = (name) => api("POST", "/api/recipes", { name });
const parseRecipe = (payload) => api("POST", "/api/recipes/parse", payload);
const saveRecipe = (id) => api("POST", `/api/recipes/${id}/save`);
const createSubtopic = (label) => api("POST", "/api/subtopics", { label });
const renameRecipe = (id, name) => api("PATCH", `/api/recipes/${id}`, { name });
const deleteRecipe = (id) => api("DELETE", `/api/recipes/${id}`);
const addIngredient = (rid, ing) => api("POST", `/api/recipes/${rid}/ingredients`, ing);
const batchIngredients = (rid, items) => api("POST", `/api/recipes/${rid}/ingredients/batch`, { items });
const replaceIngredients = (rid, items) => api("PUT", `/api/recipes/${rid}/ingredients`, { items });
const patchIngredient = (rid, iid, patch) => api("PATCH", `/api/recipes/${rid}/ingredients/${iid}`, patch);
const removeIngredient = (rid, iid) => api("DELETE", `/api/recipes/${rid}/ingredients/${iid}`);

// --- routing ----------------------------------------------------------------

function currentRoute() {
  const m = (location.hash || "#/").match(/^#\/list\/(.+)$/);
  return m ? { view: "detail", id: decodeURIComponent(m[1]) } : { view: "home" };
}

const goHome = () => (location.hash = "#/");
const openList = (id) => (location.hash = `#/list/${encodeURIComponent(id)}`);

const currentList = () => {
  const route = currentRoute();
  return route.view === "detail" ? lists.find((l) => l.id === route.id) : null;
};

function render() {
  if (activeDrag) return;
  const route = currentRoute();

  if (route.view === "detail") {
    const list = lists.find((l) => l.id === route.id);
    if (!list) {
      if (loaded) return goHome();
      return;
    }
    homeView.hidden = true;
    detailView.hidden = false;
    renderDetail(list);
  } else {
    detailView.hidden = true;
    homeView.hidden = false;
    renderHome();
  }

  // Keep any open overlays in sync with live updates.
  if (!recipesModal.hidden) renderRecipes();
  if (recipeOpenId) renderRecipe();
  if (pastOpen) renderPast();

  renderPresence();
  renderActivityBadge();
  if (activityOpen) renderActivity();
}

window.addEventListener("hashchange", render);

// --- home: list of lists ----------------------------------------------------

function renderHome() {
  detailShownId = null; // reopening a list should start in view mode
  listsEl.innerHTML = "";
  if (lists.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = loaded ? "No lists yet. Tap “+ New List” to create one." : "Loading…";
    listsEl.appendChild(empty);
    listsHint.hidden = true;
    return;
  }
  listsHint.hidden = false;
  for (const list of lists) listsEl.appendChild(renderListRow(list));
}

function renderListRow(list) {
  const meta = TYPE_META[list.type] || TYPE_META.todo;
  const total = list.items.length;
  const remaining = list.items.filter((i) => !i.done).length;
  const summary = total === 0 ? "Empty" : `${remaining} of ${total} left`;

  const row = document.createElement("li");
  row.className = "list-row";

  const del = document.createElement("button");
  del.className = "list-row__delete";
  del.type = "button";
  del.textContent = "Delete";
  del.addEventListener("click", () => deleteList(list.id));
  row.appendChild(del);

  const surface = document.createElement("div");
  surface.className = "list-row__surface";
  surface.innerHTML = `
    <span class="list-row__icon">${meta.icon}</span>
    <div class="list-row__body">
      <div class="list-row__name"></div>
      <div class="list-row__meta">${meta.label} · ${summary}</div>
    </div>
    <span class="list-row__chevron">›</span>
  `;
  surface.querySelector(".list-row__name").textContent = list.name;
  row.appendChild(surface);

  attachSwipe(surface, () => openList(list.id));
  return row;
}

// --- swipe-to-delete (list rows) --------------------------------------------

let openSurface = null;

function closeOpenSurface() {
  if (openSurface) {
    openSurface.classList.remove("is-open");
    openSurface = null;
  }
}

function attachSwipe(surface, onTap) {
  const OPEN = -88;
  const THRESHOLD = 44;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;
  let decided = false;
  let horizontal = false;

  surface.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    dragging = true;
    decided = false;
    horizontal = false;
    surface.style.transition = "none";
  });

  surface.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!decided && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      decided = true;
      horizontal = Math.abs(mx) > Math.abs(my);
      if (horizontal) {
        if (openSurface && openSurface !== surface) closeOpenSurface();
        surface.setPointerCapture(e.pointerId);
      }
    }
    if (decided && horizontal) {
      e.preventDefault();
      const base = surface.classList.contains("is-open") ? OPEN : 0;
      dx = Math.min(0, Math.max(OPEN, base + mx));
      surface.style.transform = `translateX(${dx}px)`;
    }
  });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    surface.style.transition = "";
    surface.style.transform = "";
    if (!decided) {
      if (surface.classList.contains("is-open")) closeOpenSurface();
      else onTap();
      return;
    }
    if (horizontal) {
      const shouldOpen = dx <= -THRESHOLD;
      surface.classList.toggle("is-open", shouldOpen);
      openSurface = shouldOpen ? surface : null;
    }
  };

  surface.addEventListener("pointerup", finish);
  surface.addEventListener("pointercancel", finish);
}

// --- detail view -------------------------------------------------------------

function renderDetail(list) {
  const meta = TYPE_META[list.type] || TYPE_META.todo;
  detailTitle.textContent = list.name;
  detailBadge.textContent = meta.label;

  // Opening a different list always starts in read-only view mode.
  if (detailShownId !== list.id) {
    detailShownId = list.id;
    listEditing = false;
    editingId = null;
  }

  populateAddCategory(list);

  // Edit mode reveals the add form and the structural actions; view mode keeps
  // only Undo / Redo / Clear completed (undo/redo shown as symbols).
  detailView.classList.toggle("is-editing", listEditing);
  editListBtn.textContent = listEditing ? "✓ Done" : "✎ Edit";
  editListBtn.classList.toggle("tool--accent", !listEditing);
  addForm.hidden = !listEditing;
  pastBtn.hidden = !listEditing;
  recipesBtn.hidden = !listEditing || list.type !== "groceries";
  clearAllBtn.hidden = !listEditing;
  undoBtn.disabled = !list.canUndo;
  redoBtn.disabled = !list.canRedo;

  renderGrouped(list);

  const remaining = list.items.filter((i) => !i.done).length;
  countEl.textContent = `${remaining} of ${list.items.length} left`;
}

function populateAddCategory(list) {
  const prev = pendingAddCategory || addCategory.value || MISC;
  addCategory.innerHTML = "";
  for (const [key, label] of categoriesFor(list)) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = label;
    addCategory.appendChild(o);
  }
  const nw = document.createElement("option");
  nw.value = NEW_CAT;
  nw.textContent = "➕ New subtopic…";
  addCategory.appendChild(nw);

  const has = Array.from(addCategory.options).some((o) => o.value === prev);
  addCategory.value = has ? prev : MISC;
  pendingAddCategory = null;
}

// --- grouped items -----------------------------------------------------------

function renderGrouped(list) {
  itemsEl.innerHTML = "";

  const byCat = new Map();
  for (const item of list.items) {
    const cat = categoryOf(item);
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(item);
  }

  const order = categoriesFor(list).map(([k]) => k);
  for (const k of byCat.keys()) {
    if (!order.includes(k)) order.splice(order.length - 1, 0, k); // unknowns before misc
  }

  const nonEmpty = order.filter((k) => (byCat.get(k) || []).length);
  if (nonEmpty.length === 0) {
    itemsEl.appendChild(
      emptyRow(listEditing ? "Nothing here yet. Add the first item above." : "Nothing here yet. Tap “✎ Edit” to add items.")
    );
    return;
  }
  // A plain single-bucket list shouldn't show a lone "Miscellaneous" heading.
  const showHeadings = !(nonEmpty.length === 1 && nonEmpty[0] === MISC);

  for (const key of order) {
    const group = byCat.get(key);
    if (!group || group.length === 0) continue;

    const groupEl = document.createElement("li");
    groupEl.className = "group";
    groupEl.dataset.category = key;

    if (showHeadings) {
      const heading = document.createElement("div");
      heading.className = "subtopic";
      heading.textContent = categoryLabel(list, key);
      groupEl.appendChild(heading);
    }

    const ul = document.createElement("ul");
    ul.className = "group__items";
    for (const item of group) ul.appendChild(renderItemRow(list, item));
    groupEl.appendChild(ul);

    itemsEl.appendChild(groupEl);
  }
}

function renderItemRow(list, item) {
  const li = document.createElement("li");
  li.className = "item gitem" + (item.done ? " item--done" : "");
  li.dataset.itemId = item.id;

  if (editingId === item.id) {
    li.classList.add("gitem--editing");

    const input = document.createElement("input");
    input.className = "item__edit";
    input.value = pendingEditText != null ? pendingEditText : item.text;
    pendingEditText = null;

    const select = buildCategorySelect(list, pendingEditCategory || categoryOf(item));
    pendingEditCategory = null;

    const qtyCtrl = buildQtyControls(item.qty);

    const save = () => {
      const text = input.value.trim();
      const category = select.value === NEW_CAT ? categoryOf(item) : select.value;
      editingId = null;
      patchItem(list.id, item.id, { text: text || item.text, category, qty: qtyCtrl.read() });
    };
    const cancel = () => {
      editingId = null;
      render();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") cancel();
    });

    // Handle "new subtopic" while editing, keeping the typed name.
    select.addEventListener("change", () => {
      if (select.value !== NEW_CAT) return;
      handleNewSubtopic(list, (key) => {
        pendingEditText = input.value;
        pendingEditCategory = key || categoryOf(item);
        render();
      });
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-primary btn-sm";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", save);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-ghost btn-sm";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", cancel);

    li.append(input, select, qtyCtrl.wrap, saveBtn, cancelBtn);
    setTimeout(() => input.focus(), 0);
    return li;
  }

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "gitem__handle";
  handle.setAttribute("aria-label", "Drag to another subtopic");
  handle.textContent = "⠿";
  attachItemDrag(handle, list, item);
  li.appendChild(handle);

  li.appendChild(makeCheckbox(list, item));
  li.appendChild(makeText(item));

  if (item.qty) {
    const q = document.createElement("span");
    q.className = "item__qty";
    q.textContent = formatQty(item.qty);
    li.appendChild(q);
  }

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "item__editbtn";
  edit.setAttribute("aria-label", "Edit item");
  edit.textContent = "✎";
  edit.addEventListener("click", () => {
    editingId = item.id;
    render();
  });
  li.appendChild(edit);

  li.appendChild(makeDelete(list, item));
  return li;
}

function buildCategorySelect(list, currentKey) {
  const select = document.createElement("select");
  select.className = "gedit__cat";
  for (const [key, label] of categoriesFor(list)) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = label;
    select.appendChild(o);
  }
  const nw = document.createElement("option");
  nw.value = NEW_CAT;
  nw.textContent = "➕ New subtopic…";
  select.appendChild(nw);
  select.value = currentKey;
  return select;
}

/** Prompt for a new subtopic, create it, then invoke cb(key) when known. */
function handleNewSubtopic(list, cb) {
  const label = window.prompt("New subtopic name:");
  if (!label || !label.trim()) {
    cb(null);
    return;
  }
  const key = predictKey(label);
  createCategory(list.id, label.trim());
  cb(key); // the SSE update will make the option appear; cb selects it
}

// --- small shared item pieces -----------------------------------------------

function emptyRow(text) {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = text;
  return li;
}

function makeCheckbox(list, item) {
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "item__check";
  check.checked = item.done;
  check.addEventListener("change", () => patchItem(list.id, item.id, { done: check.checked }));
  return check;
}

function makeText(item) {
  const text = document.createElement("span");
  text.className = "item__text";
  text.textContent = item.text;
  text.title = "Double-click to edit";
  text.addEventListener("dblclick", () => {
    if (!listEditing) return; // editing only in edit mode
    editingId = item.id;
    render();
  });
  return text;
}

function makeDelete(list, item) {
  const del = document.createElement("button");
  del.className = "item__delete";
  del.type = "button";
  del.setAttribute("aria-label", "Delete item");
  del.textContent = "×";
  del.addEventListener("click", () => removeItem(list.id, item.id));
  return del;
}

// --- drag an item into another subtopic -------------------------------------

function attachItemDrag(handle, list, item) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();

    const row = handle.closest(".gitem");
    const rect = row.getBoundingClientRect();

    const ghost = row.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    row.classList.add("dragging");

    activeDrag = { list, item, ghost, row, offsetY: e.clientY - rect.top, left: rect.left, targetCat: null };

    try {
      handle.setPointerCapture(e.pointerId);
    } catch {}

    const move = (ev) => onDragMove(ev);
    const up = (ev) => {
      onDragEnd(ev);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

function onDragMove(ev) {
  if (!activeDrag) return;
  const { ghost, offsetY, left } = activeDrag;
  ghost.style.top = `${ev.clientY - offsetY}px`;
  ghost.style.left = `${left}px`;

  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const group = under && under.closest(".group");
  for (const g of document.querySelectorAll(".group.drop-target")) g.classList.remove("drop-target");
  if (group) {
    group.classList.add("drop-target");
    activeDrag.targetCat = group.dataset.category;
  } else {
    activeDrag.targetCat = null;
  }
}

function onDragEnd() {
  if (!activeDrag) return;
  const { list, item, ghost, row, targetCat } = activeDrag;
  ghost.remove();
  row.classList.remove("dragging");
  for (const g of document.querySelectorAll(".group.drop-target")) g.classList.remove("drop-target");
  activeDrag = null;

  if (targetCat && targetCat !== categoryOf(item)) {
    patchItem(list.id, item.id, { category: targetCat });
  } else {
    render();
  }
}

// --- "Past items" modal ------------------------------------------------------

/** Context for the Past-items modal: which list/memory + how to render. */
function pastCtx() {
  if (pastTarget.kind === "recipe") {
    return { list: { type: "groceries", customCategories: [] }, remembered: memory.groceries || [] };
  }
  const list = currentList();
  return list ? { list, remembered: memory[list.type] || [] } : null;
}

function openPast(target) {
  pastTarget = target || { kind: "list" };
  if (!pastCtx()) return;
  pastOpen = true;
  pastSelected.clear();
  pastModal.hidden = false;
  renderPast();
}

function closePast() {
  pastOpen = false;
  pastSelected.clear();
  pastModal.hidden = true;
  pastTarget = { kind: "list" };
}

function updatePastBar() {
  const n = pastSelected.size;
  pastBar.hidden = n === 0;
  pastBarCount.textContent = `${n} selected`;
}

function renderPast() {
  const ctx = pastCtx();
  if (!ctx) return closePast();
  const { list, remembered } = ctx;

  pastBody.innerHTML = "";

  const byCat = new Map();
  for (const r of remembered) {
    const cat = r.category || MISC;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(r);
  }

  const order = categoriesFor(list).map(([k]) => k);
  for (const k of byCat.keys()) {
    if (!order.includes(k)) order.splice(order.length - 1, 0, k);
  }

  let any = false;
  for (const key of order) {
    const group = byCat.get(key);
    if (!group || group.length === 0) continue;
    any = true;
    group.sort((a, b) => a.name.localeCompare(b.name));

    const heading = document.createElement("div");
    heading.className = "subtopic";
    // Prefer the current list's label; fall back to the label stored with the
    // remembered item (for custom subtopics this list doesn't have yet).
    const label = categoryLabel(list, key);
    heading.textContent = label === key && group[0].label ? group[0].label : label;
    pastBody.appendChild(heading);

    for (const r of group) pastBody.appendChild(renderPastRow(list, r));
  }

  if (!any) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No past items yet. Check items off and use “Clear completed” — they'll show up here.";
    pastBody.appendChild(empty);
  }

  updatePastBar();
}

function renderPastRow(list, r) {
  const row = document.createElement("div");
  row.className = "past-item" + (pastSelected.has(r.key) ? " is-selected" : "");
  row.setAttribute("role", "button");

  const box = document.createElement("span");
  box.className = "past-item__check";
  row.appendChild(box);

  const name = document.createElement("span");
  name.className = "past-item__name";
  name.textContent = r.name;
  row.appendChild(name);

  // Forgetting is only meaningful when the modal targets a real list.
  if (pastTarget.kind === "list" && list.id) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "past-item__delete";
    del.setAttribute("aria-label", "Forget this item");
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      pastSelected.delete(r.key);
      forgetItem(list.id, r.key);
    });
    row.appendChild(del);
  }

  row.addEventListener("click", () => {
    if (pastSelected.has(r.key)) pastSelected.delete(r.key);
    else pastSelected.add(r.key);
    row.classList.toggle("is-selected");
    updatePastBar();
  });

  return row;
}

function addSelectedPast() {
  const ctx = pastCtx();
  if (!ctx) return;
  const chosen = ctx.remembered.filter((r) => pastSelected.has(r.key));
  if (!chosen.length) return;
  if (pastTarget.kind === "recipe") {
    // Past-items is only reachable in edit mode → add to the draft buffer.
    if (recipeEditing && draftIngredients) {
      for (const r of chosen) draftIngredients.push({ id: tmpId(), text: r.name, category: r.category, qty: null });
      renderRecipe();
    }
  } else {
    batchAdd(
      ctx.list.id,
      chosen.map((r) => ({ text: r.name, category: r.category, label: r.label }))
    );
  }
  closePast();
}

pastBtn.addEventListener("click", () => openPast({ kind: "list" }));
pastClose.addEventListener("click", closePast);
pastBackdrop.addEventListener("click", closePast);
pastAdd.addEventListener("click", addSelectedPast);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && pastOpen) closePast();
});

// --- recipes -----------------------------------------------------------------

function buildRecipeCatSelect(selected) {
  const sel = document.createElement("select");
  sel.className = "ing-row__cat";
  fillRecipeCatSelect(sel, selected, false);
  return sel;
}

function currentRecipe() {
  return recipes.find((r) => r.id === recipeOpenId) || null;
}

function openRecipes() {
  recipesModal.hidden = false;
  newRecipeName.value = "";
  renderRecipes();
}

function resetImportForm() {
  recipeImportForm.hidden = true;
  recipeImportToggle.setAttribute("aria-expanded", "false");
  importUrl.value = "";
  importText.value = "";
  importStatus.textContent = "";
  importStatus.classList.remove("recipe-import__status--error");
  importSubmit.disabled = false;
}

async function submitImport() {
  if (!recipeEditing || !draftIngredients) return;
  const url = importUrl.value.trim();
  const text = importText.value.trim();
  if (!url && !text) {
    importStatus.textContent = "Paste a URL or some recipe text first.";
    importStatus.classList.add("recipe-import__status--error");
    return;
  }

  importStatus.classList.remove("recipe-import__status--error");
  importStatus.textContent = url ? "Reading the page…" : "Parsing…";
  importSubmit.disabled = true;

  try {
    const res = await parseRecipe({ url, text });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      importStatus.textContent = data.error || "Import failed.";
      importStatus.classList.add("recipe-import__status--error");
      importSubmit.disabled = false;
      return;
    }
    for (const ing of data.ingredients || []) {
      draftIngredients.push({
        id: tmpId(),
        text: ing.text,
        category: ing.category || MISC,
        qty: ing.qty || null,
      });
    }
    resetImportForm();
    renderRecipe();
  } catch {
    importStatus.textContent = "Something went wrong. Try again.";
    importStatus.classList.add("recipe-import__status--error");
    importSubmit.disabled = false;
  }
}

function closeRecipes() {
  recipesModal.hidden = true;
}

function renderRecipes() {
  recipesListEl.innerHTML = "";
  if (!recipes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No recipes yet. Name one above to get started.";
    recipesListEl.appendChild(empty);
    return;
  }
  for (const r of recipes) recipesListEl.appendChild(renderRecipeRow(r));
}

function renderRecipeRow(recipe) {
  const row = document.createElement("div");
  row.className = "recipe-row";

  const body = document.createElement("div");
  body.className = "recipe-row__body";
  const name = document.createElement("div");
  name.className = "recipe-row__name";
  name.textContent = recipe.name;
  const meta = document.createElement("div");
  meta.className = "recipe-row__meta";
  const n = recipe.ingredients.length;
  meta.textContent = n === 1 ? "1 ingredient" : `${n} ingredients`;
  body.append(name, meta);

  const chevron = document.createElement("span");
  chevron.className = "recipe-row__chevron";
  chevron.textContent = "›";

  const del = document.createElement("button");
  del.type = "button";
  del.className = "recipe-row__delete";
  del.setAttribute("aria-label", "Delete recipe");
  del.textContent = "×";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm(`Delete recipe “${recipe.name}”?`)) deleteRecipe(recipe.id);
  });

  row.append(body, chevron, del);
  row.addEventListener("click", () => openRecipe(recipe.id));
  return row;
}

async function submitNewRecipe() {
  const name = newRecipeName.value.trim();
  if (!name) {
    newRecipeName.focus();
    return;
  }
  const res = await createRecipe(name);
  newRecipeName.value = "";
  try {
    const data = await res.json();
    if (data && data.id) openRecipe(data.id, { edit: true });
  } catch {}
}

function openRecipe(id, opts) {
  recipeOpenId = id;
  recipeEditing = false;
  draftIngredients = null;
  draftName = null;
  editingIngId = null;
  recipeSelected.clear();
  recipesModal.hidden = true;
  recipeModal.hidden = false;
  ingText.value = "";
  ingAmount.value = "";
  if (opts && opts.edit) enterRecipeEdit();
  else renderRecipe();
}

function closeRecipe() {
  recipeOpenId = null;
  recipeEditing = false;
  draftIngredients = null;
  draftName = null;
  editingIngId = null;
  resetImportForm();
  recipeModal.hidden = true;
}

function enterRecipeEdit() {
  const recipe = currentRecipe();
  if (!recipe) return;
  recipeEditing = true;
  draftName = recipe.name;
  draftIngredients = recipe.ingredients.map((i) => ({
    id: i.id,
    text: i.text,
    category: i.category,
    qty: i.qty ? { ...i.qty } : null,
  }));
  editingIngId = null;
  resetImportForm();
  renderRecipe();
}

function discardRecipeEdit() {
  recipeEditing = false;
  draftIngredients = null;
  draftName = null;
  editingIngId = null;
  resetImportForm();
  renderRecipe();
}

function recipeQtyEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.amount === b.amount && a.unit === b.unit;
}

/** True when edit mode has ingredient or name changes that haven't been saved. */
function hasUnsavedRecipeEdits() {
  if (!recipeEditing || !draftIngredients) return false;
  const recipe = currentRecipe();
  if (!recipe) return false;

  const name = (recipeEditing && document.activeElement === recipeName ? recipeName.value : draftName || "").trim();
  if (name !== recipe.name) return true;

  const saved = recipe.ingredients;
  if (draftIngredients.length !== saved.length) return true;

  const savedById = new Map(saved.map((i) => [i.id, i]));
  for (const d of draftIngredients) {
    if (String(d.id).startsWith("tmp-")) return true;
    const s = savedById.get(d.id);
    if (!s) return true;
    if (d.text !== s.text || (d.category || MISC) !== (s.category || MISC)) return true;
    if (!recipeQtyEqual(d.qty, s.qty)) return true;
  }
  for (const s of saved) {
    if (!draftIngredients.some((d) => d.id === s.id)) return true;
  }
  return false;
}

function confirmLeaveRecipe() {
  if (!hasUnsavedRecipeEdits()) return true;
  return confirm("Are you sure you want to return to recipes without saving?");
}

function leaveRecipeToRecipes() {
  if (recipeEditing && document.activeElement === recipeName) draftName = recipeName.value;
  if (!confirmLeaveRecipe()) return;
  closeRecipe();
  openRecipes();
}

function leaveRecipeAndClose() {
  if (recipeEditing && document.activeElement === recipeName) draftName = recipeName.value;
  if (!confirmLeaveRecipe()) return;
  closeRecipe();
  closeRecipes();
}

async function saveRecipeEdits() {
  const recipe = currentRecipe();
  if (!recipe || !draftIngredients) return;
  const items = draftIngredients.map((i) => ({ text: i.text, category: i.category, qty: i.qty }));
  const name = (draftName || "").trim();
  await replaceIngredients(recipe.id, items);
  if (name && name !== recipe.name) await renameRecipe(recipe.id, name);
  await saveRecipe(recipe.id); // push ingredients into grocery memory (deduped)
  recipeEditing = false;
  draftIngredients = null;
  draftName = null;
  editingIngId = null;
  resetImportForm();
  renderRecipe();
}

/** Ingredients currently shown: the draft while editing, else the saved set. */
function workingIngredients() {
  if (recipeEditing) return draftIngredients || [];
  const recipe = currentRecipe();
  return recipe ? recipe.ingredients : [];
}

function renderRecipe() {
  const recipe = currentRecipe();
  if (!recipe) return closeRecipe();

  // Name: read-only title in view mode, editable (buffered) in edit mode.
  recipeName.readOnly = !recipeEditing;
  if (document.activeElement !== recipeName) {
    recipeName.value = recipeEditing && draftName != null ? draftName : recipe.name;
  }

  // Mode-dependent chrome.
  recipeEditBtn.hidden = recipeEditing;
  recipeEditControls.hidden = !recipeEditing;
  recipeViewFoot.hidden = recipeEditing;
  recipeEditFoot.hidden = !recipeEditing;

  if (recipeEditing) {
    // Keep the add-ingredient subtopic dropdown in sync with the shared catalog.
    const prevCat = pendingIngAddCat || ingCategory.value || MISC;
    fillRecipeCatSelect(ingCategory, prevCat, true);
    pendingIngAddCat = null;
  } else {
    populateRecipeDest();
  }

  const items = workingIngredients();
  ingList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = recipeEditing
      ? "No ingredients yet. Add some above, import from the web, or pull from past items."
      : "No ingredients yet. Tap “✎ Edit” to add some.";
    ingList.appendChild(empty);
    if (!recipeEditing) updateRecipeSelCount();
    return;
  }

  // Group ingredients under subtopic headings (presets, custom, misc last).
  const byCat = new Map();
  for (const ing of items) {
    const cat = ing.category || MISC;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(ing);
  }
  const order = recipeCatalog().map(([k]) => k);
  for (const k of byCat.keys()) {
    if (!order.includes(k)) order.splice(order.length - 1, 0, k);
  }
  for (const key of order) {
    const group = byCat.get(key);
    if (!group || !group.length) continue;
    const heading = document.createElement("div");
    heading.className = "subtopic";
    heading.textContent = catalogLabel(key);
    ingList.appendChild(heading);
    for (const ing of group) ingList.appendChild(renderIngredientRow(recipe, ing));
  }

  if (!recipeEditing) updateRecipeSelCount();
}

function renderIngredientRow(recipe, ing) {
  const row = document.createElement("div");

  // =========================== EDIT MODE ================================
  if (recipeEditing) {
    // Inline editor for one ingredient (name + type + quantity).
    if (editingIngId === ing.id) {
      row.className = "ing-row ing-row--editing";

      const input = document.createElement("input");
      input.className = "item__edit";
      input.value = ing.text;

      const cat = buildRecipeCatSelect(ing.category || MISC);
      const qtyCtrl = buildQtyControls(ing.qty);

      const save = () => {
        const entry = draftIngredients.find((d) => d.id === ing.id);
        if (entry) {
          entry.text = input.value.trim() || entry.text;
          entry.category = cat.value;
          entry.qty = qtyCtrl.read();
        }
        editingIngId = null;
        renderRecipe();
      };
      const cancel = () => {
        editingIngId = null;
        renderRecipe();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") cancel();
      });

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn-primary btn-sm";
      saveBtn.textContent = "Done";
      saveBtn.addEventListener("click", save);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn-ghost btn-sm";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", cancel);

      row.append(input, cat, qtyCtrl.wrap, saveBtn, cancelBtn);
      setTimeout(() => input.focus(), 0);
      return row;
    }

    // Editable row: name + qty, with edit + delete buttons.
    row.className = "ing-row";

    const name = document.createElement("span");
    name.className = "ing-row__name";
    name.textContent = ing.text;
    row.appendChild(name);

    if (ing.qty) {
      const q = document.createElement("span");
      q.className = "item__qty";
      q.textContent = formatQty(ing.qty);
      row.appendChild(q);
    }

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "item__editbtn";
    edit.setAttribute("aria-label", "Edit ingredient");
    edit.textContent = "✎";
    edit.addEventListener("click", () => {
      editingIngId = ing.id;
      renderRecipe();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "ing-row__delete";
    del.setAttribute("aria-label", "Remove ingredient");
    del.textContent = "×";
    del.addEventListener("click", () => {
      draftIngredients = draftIngredients.filter((d) => d.id !== ing.id);
      renderRecipe();
    });

    row.append(edit, del);
    return row;
  }

  // =========================== VIEW MODE ================================
  row.className = "ing-row" + (recipeSelected.has(ing.id) ? " is-selected" : "");

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "ing-row__check";
  check.checked = recipeSelected.has(ing.id);
  check.title = "Select to add to a list";
  check.addEventListener("change", () => {
    if (check.checked) recipeSelected.add(ing.id);
    else recipeSelected.delete(ing.id);
    row.classList.toggle("is-selected", check.checked);
    updateRecipeSelCount();
  });

  const name = document.createElement("span");
  name.className = "ing-row__name";
  name.textContent = ing.text;

  row.append(check, name);

  if (ing.qty) {
    const q = document.createElement("span");
    q.className = "item__qty";
    q.textContent = formatQty(ing.qty);
    row.appendChild(q);
  }

  return row;
}

function populateRecipeDest() {
  const prev = recipeDestId || recipeDest.value;
  recipeDest.innerHTML = "";
  if (!lists.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "(no lists yet)";
    recipeDest.appendChild(o);
    recipeDestId = null;
    return;
  }
  for (const l of lists) {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = l.name;
    recipeDest.appendChild(o);
  }
  let target = prev && lists.some((l) => l.id === prev) ? prev : null;
  if (!target) {
    const grocery = lists.find((l) => l.type === "groceries");
    target = grocery ? grocery.id : lists[0].id;
  }
  recipeDest.value = target;
  recipeDestId = target;
}

function updateRecipeSelCount() {
  const recipe = currentRecipe();
  const total = recipe ? recipe.ingredients.length : 0;
  const n = recipeSelected.size;
  recipeAddToList.textContent = n > 0 ? `Add ${n} to list` : `Add all (${total})`;
  recipeAddToList.disabled = total === 0;
}

function addSelectedToList() {
  const recipe = currentRecipe();
  if (!recipe) return;
  const dest = lists.find((l) => l.id === recipeDest.value);
  if (!dest) {
    alert("Create a list first, then add ingredients to it.");
    return;
  }
  const chosen = recipe.ingredients.filter((i) => recipeSelected.has(i.id));
  const source = chosen.length ? chosen : recipe.ingredients;
  const items = source.map((i) => ({ text: i.text, category: i.category, qty: i.qty, label: catalogLabel(i.category) }));
  if (!items.length) return;
  recipeDestId = dest.id;
  batchAdd(dest.id, items);
  closeRecipe();
  closeRecipes();
  openList(dest.id);
}

function readIngFormQty() {
  const a = Number(ingAmount.value);
  if (ingAmount.value === "" || !Number.isFinite(a) || a <= 0) return null;
  return { amount: a, unit: ingUnit.value };
}

function addIngredientFromForm() {
  if (!recipeEditing || !draftIngredients) return;
  const text = ingText.value.trim();
  if (!text) return;
  draftIngredients.push({ id: tmpId(), text, category: ingCategory.value, qty: readIngFormQty() });
  ingText.value = "";
  ingAmount.value = "";
  ingText.focus();
  renderRecipe();
}

// Populate the static add-ingredient controls (refreshed on each recipe render).
fillRecipeCatSelect(ingCategory, MISC, true);
fillUnitSelect(ingUnit, "each");
wireConverter(ingUnit, ingAmount);

ingCategory.addEventListener("change", () => {
  if (ingCategory.value !== NEW_CAT) return;
  const label = prompt("New subtopic name:");
  if (!label || !label.trim()) {
    ingCategory.value = MISC;
    return;
  }
  pendingIngAddCat = predictKey(label); // survive the re-render, then select it
  createSubtopic(label.trim());
});

recipesBtn.addEventListener("click", () => {
  const list = currentList();
  if (list) recipeDestId = list.id; // default "Add to" this grocery list
  openRecipes();
});
recipesClose.addEventListener("click", closeRecipes);
recipesBackdrop.addEventListener("click", closeRecipes);
newRecipeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitNewRecipe();
});
recipeImportToggle.addEventListener("click", () => {
  const show = recipeImportForm.hidden;
  recipeImportForm.hidden = !show;
  recipeImportToggle.setAttribute("aria-expanded", String(show));
  if (show) importUrl.focus();
});
recipeImportForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitImport();
});

recipeClose.addEventListener("click", leaveRecipeAndClose);
recipeBackdrop.addEventListener("click", leaveRecipeAndClose);
recipeBack.addEventListener("click", leaveRecipeToRecipes);
recipeName.addEventListener("input", () => {
  if (recipeEditing) draftName = recipeName.value;
});
recipeEditBtn.addEventListener("click", enterRecipeEdit);
recipeSave.addEventListener("click", saveRecipeEdits);
recipeDiscard.addEventListener("click", discardRecipeEdit);
ingAddForm.addEventListener("submit", (e) => {
  e.preventDefault();
  addIngredientFromForm();
});
ingFromPast.addEventListener("click", () => {
  const recipe = currentRecipe();
  if (recipe) openPast({ kind: "recipe", recipeId: recipe.id });
});
recipeAddToList.addEventListener("click", addSelectedToList);
recipeDest.addEventListener("change", () => (recipeDestId = recipeDest.value));
recipeDelete.addEventListener("click", () => {
  const recipe = currentRecipe();
  if (recipe && confirm(`Delete recipe “${recipe.name}”?`)) {
    deleteRecipe(recipe.id);
    closeRecipe();
    openRecipes();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || pastOpen) return;
  if (activityOpen) {
    closeActivity();
  } else if (!recipeModal.hidden) {
    leaveRecipeToRecipes();
  } else if (!recipesModal.hidden) {
    closeRecipes();
  }
});

// --- new-list dropdown -------------------------------------------------------

function openPanel() {
  newListPanel.hidden = false;
  newListBtn.setAttribute("aria-expanded", "true");
  newListName.value = "";
  newListType.value = "todo";
  setTimeout(() => newListName.focus(), 0);
}

function closePanel() {
  newListPanel.hidden = true;
  newListBtn.setAttribute("aria-expanded", "false");
}

function submitNewList() {
  const name = newListName.value.trim();
  const type = newListType.value;
  if (!name) {
    newListName.focus();
    return;
  }
  createList(name, type);
  closePanel();
}

newListBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (newListPanel.hidden) openPanel();
  else closePanel();
});
newListCreate.addEventListener("click", submitNewList);
newListCancel.addEventListener("click", closePanel);
newListName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitNewList();
  if (e.key === "Escape") closePanel();
});
newListType.addEventListener("change", () => {
  if (newListType.value === "groceries" && !newListName.value.trim()) {
    newListName.value = "Groceries List";
  }
});
document.addEventListener("click", (e) => {
  if (!newListPanel.hidden && !newListPanel.contains(e.target) && e.target !== newListBtn) {
    closePanel();
  }
});

// --- add bar + toolbar -------------------------------------------------------

addCategory.addEventListener("change", () => {
  if (addCategory.value !== NEW_CAT) return;
  const list = currentList();
  if (!list) return;
  handleNewSubtopic(list, (key) => {
    pendingAddCategory = key || MISC;
    render();
  });
});

addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const list = currentList();
  if (!list) return;
  const text = addInput.value.trim();
  if (!text) return;
  const category = addCategory.value === NEW_CAT ? MISC : addCategory.value;
  addInput.value = "";
  addItem(list.id, text, category);
});

editListBtn.addEventListener("click", () => {
  listEditing = !listEditing;
  if (!listEditing) editingId = null; // leaving edit mode cancels any inline edit
  render();
});

clearDoneBtn.addEventListener("click", () => {
  const list = currentList();
  if (list) clearCompleted(list.id);
});

clearAllBtn.addEventListener("click", () => {
  const list = currentList();
  if (!list || list.items.length === 0) return;
  if (confirm(`Clear all ${list.items.length} item(s) from “${list.name}”? You can undo this.`)) {
    clearAll(list.id);
  }
});

undoBtn.addEventListener("click", () => {
  const list = currentList();
  if (list) undo(list.id);
});
redoBtn.addEventListener("click", () => {
  const list = currentList();
  if (list) redo(list.id);
});
backBtn.addEventListener("click", goHome);

// --- presence: who's online -------------------------------------------------

const ID_KEY = "lists.clientId";
const NAME_KEY = "lists.name";

const cleanName = (raw) =>
  String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, 40) || "Guest";

let myId = localStorage.getItem(ID_KEY);
if (!myId) {
  myId = (crypto.randomUUID && crypto.randomUUID()) || `c-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(ID_KEY, myId);
}
let myName = localStorage.getItem(NAME_KEY) || "";
if (!myName) {
  myName = cleanName(window.prompt("Enter your name so others can see who's on the list:", "Guest"));
  localStorage.setItem(NAME_KEY, myName);
}

let presence = [];

const currentListId = () => {
  const r = currentRoute();
  return r.view === "detail" ? r.id : null;
};

/** Dedupe presence entries by client id (one person may have several tabs). */
function uniqueUsers(entries) {
  const map = new Map();
  for (const u of entries) if (!map.has(u.id)) map.set(u.id, u);
  return Array.from(map.values());
}

function nameInitials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

function nameColor(seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

function avatarEl(user) {
  const a = document.createElement("span");
  a.className = "avatar";
  a.textContent = nameInitials(user.name);
  a.style.background = nameColor(user.id);
  a.title = user.id === myId ? `${user.name} (you)` : user.name;
  return a;
}

function renderPresence() {
  const everyone = uniqueUsers(presence);

  // Status bar: total online + avatars (click to rename yourself).
  presenceEl.hidden = everyone.length === 0;
  presenceEl.innerHTML = "";
  if (everyone.length) {
    const count = document.createElement("span");
    count.className = "presence__count";
    count.textContent = `${everyone.length} online`;
    presenceEl.appendChild(count);
    const avs = document.createElement("span");
    avs.className = "presence__avatars";
    for (const u of everyone) avs.appendChild(avatarEl(u));
    presenceEl.appendChild(avs);
  }

  // Detail view: who is currently on this list.
  const listId = currentListId();
  if (listId) {
    const here = uniqueUsers(presence.filter((u) => u.listId === listId));
    detailViewers.hidden = here.length === 0;
    detailViewers.innerHTML = "";
    if (here.length) {
      const label = document.createElement("span");
      label.className = "viewers__label";
      label.textContent = "Here now";
      detailViewers.appendChild(label);
      for (const u of here) {
        const chip = document.createElement("span");
        chip.className = "viewer";
        chip.appendChild(avatarEl(u));
        const nm = document.createElement("span");
        nm.className = "viewer__name";
        nm.textContent = u.id === myId ? `${u.name} (you)` : u.name;
        chip.appendChild(nm);
        detailViewers.appendChild(chip);
      }
    }
  } else {
    detailViewers.hidden = true;
  }
}

/** Tell the server which list we're viewing now (and our current name). */
function pushPresence() {
  fetch("/api/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: myId, name: myName, listId: currentListId() }),
  }).catch(() => {});
}

function changeName() {
  const next = window.prompt("Your name (others will see this):", myName);
  if (next == null) return;
  myName = cleanName(next);
  localStorage.setItem(NAME_KEY, myName);
  pushPresence();
}

presenceEl.addEventListener("click", changeName);
window.addEventListener("hashchange", pushPresence);

// --- activity feed / notifications ------------------------------------------

const SEEN_KEY = "lists.activitySeen";
let activity = [];
let activitySeenTs = Number(localStorage.getItem(SEEN_KEY) || 0);
let activityOpen = false;

/** Changes that count as "new" for me: after my last view and not made by me. */
function unreadActivity() {
  return activity.filter((a) => a.ts > activitySeenTs && a.actorId !== myId);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function activityText(a) {
  const q = (s) => `“${s}”`;
  const inList = a.listName ? ` in ${a.listName}` : "";
  switch (a.action) {
    case "add":
      return `added ${q(a.detail)}${inList}`;
    case "check":
      return `checked off ${q(a.detail)}${inList}`;
    case "uncheck":
      return `unchecked ${q(a.detail)}${inList}`;
    case "edit":
      return `edited ${q(a.detail)}${inList}`;
    case "delete":
      return `removed ${q(a.detail)}${inList}`;
    case "clearDone":
      return `cleared ${a.detail}${inList}`;
    case "clearAll":
      return `cleared everything (${a.detail})${inList}`;
    case "createList":
      return `created the list ${q(a.detail)}`;
    case "renameList":
      return `renamed a list to ${q(a.detail)}`;
    case "deleteList":
      return `deleted the list ${q(a.detail)}`;
    default:
      return a.detail || "made a change";
  }
}

function renderActivityBadge() {
  const n = unreadActivity().length;
  activityBadge.hidden = n === 0;
  activityBadge.textContent = n > 99 ? "99+" : String(n);
  activityBtn.classList.toggle("activitybtn--alert", n > 0);
  activityMarkRead.disabled = n === 0;
  activityClear.disabled = activity.length === 0;
}

function renderActivity() {
  activityBody.innerHTML = "";
  if (!activity.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No activity yet. Changes people make will show up here.";
    activityBody.appendChild(empty);
    return;
  }
  const rows = [...activity].sort((a, b) => b.ts - a.ts);
  for (const a of rows) {
    const row = document.createElement("div");
    const unread = a.ts > activitySeenTs && a.actorId !== myId;
    row.className = "activity" + (unread ? " activity--unread" : "");

    row.appendChild(avatarEl({ id: a.actorId || a.actorName, name: a.actorName }));

    const body = document.createElement("div");
    body.className = "activity__body";
    const line = document.createElement("div");
    line.className = "activity__line";
    const who = document.createElement("strong");
    who.textContent = a.actorId === myId ? "You" : a.actorName;
    line.appendChild(who);
    line.appendChild(document.createTextNode(" " + activityText(a)));
    const meta = document.createElement("div");
    meta.className = "activity__meta";
    meta.textContent = timeAgo(a.ts);
    body.append(line, meta);
    row.appendChild(body);

    if (a.listId && lists.some((l) => l.id === a.listId)) {
      row.classList.add("activity--link");
      row.addEventListener("click", () => {
        closeActivity();
        openList(a.listId);
      });
    }
    activityBody.appendChild(row);
  }
}

function markActivitySeen() {
  const newest = activity.reduce((m, a) => Math.max(m, a.ts), 0);
  if (newest > activitySeenTs) {
    activitySeenTs = newest;
    localStorage.setItem(SEEN_KEY, String(activitySeenTs));
  }
  renderActivityBadge();
}

function openActivity() {
  activityOpen = true;
  activityModal.hidden = false;
  renderActivity(); // unread items stay highlighted until "Mark read"
}

function closeActivity() {
  activityOpen = false;
  activityModal.hidden = true;
}

activityBtn.addEventListener("click", openActivity);
activityClose.addEventListener("click", closeActivity);
activityBackdrop.addEventListener("click", closeActivity);
activityMarkRead.addEventListener("click", () => {
  markActivitySeen(); // clears my badge, keeps the history
  renderActivity(); // drop the unread highlights
});
activityClear.addEventListener("click", () => {
  if (!activity.length) return;
  if (confirm("Clear the activity feed for everyone?")) clearActivity();
});

// --- connection status + real-time stream -----------------------------------

let everConnected = false;

function setConnected(connected) {
  statusEl.classList.toggle("status--online", connected);
  if (connected) {
    everConnected = true;
    statusText.textContent = "Live — synced";
  } else {
    statusText.textContent = everConnected ? "Reconnecting…" : "Starting server…";
  }
}

function connect() {
  const params = new URLSearchParams({ id: myId, name: myName });
  const listId = currentListId();
  if (listId) params.set("listId", listId);
  const source = new EventSource(`/api/events?${params.toString()}`);

  source.addEventListener("state", (e) => {
    setConnected(true);
    loaded = true;
    const payload = JSON.parse(e.data);
    lists = payload.lists || [];
    memory = payload.remembered || { todo: [], groceries: [] };
    recipes = payload.recipes || [];
    grocerySubtopics = payload.grocerySubtopics || [];
    activity = payload.activity || [];

    if (editingId) {
      const exists = lists.some((l) => l.items.some((i) => i.id === editingId));
      if (!exists) editingId = null;
    }
    render();
  });

  source.addEventListener("presence", (e) => {
    presence = JSON.parse(e.data);
    renderPresence();
  });

  // On (re)connect, native EventSource reuses the original URL, so re-sync the
  // list we're actually viewing.
  source.addEventListener("open", () => {
    setConnected(true);
    pushPresence();
  });
  source.addEventListener("error", () => setConnected(false));
}

// On phones, keep the focused field visible when the keyboard opens.
if (window.matchMedia("(max-width: 600px)").matches) {
  document.addEventListener("focusin", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.matches("input, textarea, select")) return;
    setTimeout(() => {
      target.scrollIntoView({ block: "center", behavior: "auto" });
    }, 350);
  });
}

connect();
render();
