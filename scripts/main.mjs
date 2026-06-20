const MODULE_ID = "crucible-party-stash";
const DEBUG_PREFIX = `[${MODULE_ID}]`;

/* ─── Debug Logger ─── */

const log = {
  _enabled: true,
  info(...args) {
    if (!this._enabled) return;
    console.log(DEBUG_PREFIX, ...args);
  },
  warn(...args) {
    console.warn(DEBUG_PREFIX, "[WARN]", ...args);
  },
  error(...args) {
    console.error(DEBUG_PREFIX, "[ERROR]", ...args);
  },
  group(label) {
    if (!this._enabled) return;
    console.group(DEBUG_PREFIX, label);
  },
  groupEnd() {
    if (!this._enabled) return;
    console.groupEnd();
  }
};

/* ─── Global Debug API ─── */

window.CRUCIBLE_STASH_DEBUG = {
  logging: true,
  moduleId: MODULE_ID,

  status() {
    console.log(`[${MODULE_ID}] === Status ===`);
    console.log("Module loaded:", true);
    const s1 = game.settings.settings.has(`${MODULE_ID}.stashCapacity`);
    const s2 = game.settings.settings.has(`${MODULE_ID}.confirmTransfer`);
    console.log("Settings registered:", s1 && s2);
    console.log("World:", game.world?.title);
    console.log("System:", game.system?.id, game.system?.version);
    console.log("Foundry:", game.version);
  },

  groups() {
    const groups = game.actors?.filter(a => a.type === "group") ?? [];
    if (!groups.length) {
      console.warn(`[${MODULE_ID}] No group actors found.`);
      return;
    }
    for (const g of groups) {
      const stash = g.getFlag(MODULE_ID, "stash") ?? [];
      console.group(`Group: ${g.name} (${g.id})`);
      console.log("Stash items:", stash.length);
      console.log("Sheet open:", !!g.sheet);
      console.log("Sheet class:", g.sheet?.constructor?.name);
      console.log("Sheet rendered:", g.sheet?.rendered);
      console.groupEnd();
    }
    return groups;
  },

  async addTestItem() {
    const group = game.actors?.find(a => a.type === "group");
    if (!group) return console.error(`[${MODULE_ID}] No group actor`);
    const testItem = {
      _id: foundry.utils.randomID(),
      _stashId: foundry.utils.randomID(),
      name: "Test Sword",
      type: "weapon",
      img: "systems/crucible/assets/icons/weapons/sword.svg",
      system: { quantity: 1 }
    };
    const stash = foundry.utils.deepClone(group.getFlag(MODULE_ID, "stash") ?? []);
    stash.push(testItem);
    await group.setFlag(MODULE_ID, "stash", stash);
    console.log(`[${MODULE_ID}] Test item added to ${group.name}`);
  },

  hooks() {
    console.log(`[${MODULE_ID}] === Hook Diagnostics ===`);
    console.log("To see hooks firing, run: CONFIG.debug.hooks = true");
    // V14 uses a private #hooks field — Hooks._hooks is undefined.
    // Fallback: try to find the internal storage via reflection
    let storage = null;
    for (const key of Object.getOwnPropertyNames(Hooks)) {
      try { if (Hooks[key]?.["init"]) storage = Hooks[key]; } catch {}
    }
    if (storage) {
      const names = ["init","ready","preloadTemplates","renderCrucibleGroupActorSheet","renderActorSheetV2","renderActorSheet","dropActorSheetData","renderApplication"];
      for (const n of names) console.log(`  ${n}: ${(storage[n]?.length ?? "(n/a)")} handlers`);
    } else {
      console.log("Could not locate internal hooks storage via reflection.");
      console.log("Hooks keys:", Object.getOwnPropertyNames(Hooks));
    }
  },

  inspectSheet() {
    const el = document.querySelector(".actor-group.application, .actor-group.sheet");
    if (!el) {
      console.warn(`[${MODULE_ID}] No group sheet in DOM`);
      document.querySelectorAll(".application").forEach(s => console.log("  App:", s.className));
      return;
    }
    console.log(`[${MODULE_ID}] === Sheet DOM ===`);
    console.log("Class:", el.className);
    function walk(node, depth) {
      if (depth > 6 || !node?.tagName) return;
      const parts = [`${"  ".repeat(depth)}${node.tagName}`];
      if (node.className && typeof node.className === 'string') parts.push(`.${node.className.replace(/ /g, '.')}`);
      if (node.dataset?.applicationPart) parts.push(`[part=${node.dataset.applicationPart}]`);
      if (node.id) parts.push(`#${node.id}`);
      console.log(parts.join(""));
      for (const c of node.children) walk(c, depth + 1);
    }
    walk(el, 0);
  },

  help() {
    console.log("Debug commands:");
    console.log("  .status()        — module state");
    console.log("  .groups()        — list groups & stash");
    console.log("  .addTestItem()   — add test item");
    console.log("  .hooks()         — hook diagnostics");
    console.log("  .inspectSheet()  — dump sheet DOM tree");
    console.log("  .logging = false — quiet logging");
  }
};

/* ─── Utilities ─── */

function _getStash(groupActor) {
  return foundry.utils.deepClone(groupActor.getFlag(MODULE_ID, "stash") ?? []);
}

async function _setStash(groupActor, stash) {
  await groupActor.setFlag(MODULE_ID, "stash", stash);
}

function _checkStashCapacity(stash) {
  const max = game.settings.get(MODULE_ID, "stashCapacity");
  return { ok: max === 0 || stash.length < max, max };
}

/* ─── Initialization ─── */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  game.settings.register(MODULE_ID, "stashCapacity", {
    name: "CRUCIBLE_PARTY_STASH.StashCapacity",
    hint: "CRUCIBLE_PARTY_STASH.StashCapacityHint",
    scope: "world", config: true, type: Number, default: 0
  });

  game.settings.register(MODULE_ID, "confirmTransfer", {
    name: "CRUCIBLE_PARTY_STASH.ConfirmTransfer",
    hint: "CRUCIBLE_PARTY_STASH.ConfirmTransferHint",
    scope: "world", config: true, type: Boolean, default: true
  });
});

/* ─── Template Preloading ─── */

Hooks.once("preloadTemplates", async () => {
  try {
    await loadTemplates([`modules/${MODULE_ID}/templates/stash-panel.hbs`]);
  } catch (err) {
    log.error("Template preload:", err);
  }
});

/* ─── Core Injection Logic ───
 * Called by: hooks (if they fire) OR MutationObserver (ultimate fallback). */

function _onGroupSheetRender(app, element) {
  console.log(`${MODULE_ID} | _onGroupSheetRender called`, app.constructor?.name);

  const actor = app.actor;
  if (!actor || actor.type !== "group") return;

  if (element.querySelector(".party-stash-tabs")) return;

  const isEditable = app.isEditable;
  const stashItems = _getStash(actor);

  // V2 sheet: rendered parts are in [data-application-part] elements.
  // Target the first part container, or window-content, or element itself.
  const contentArea =
    element.querySelector("[data-application-part]") ||
    element.querySelector(".window-content") ||
    element;
  console.log(`${MODULE_ID} | Content:`, contentArea.tagName);

  // Tab bar
  const tabBar = document.createElement("nav");
  tabBar.className = "party-stash-tabs sheet-tabs";
  tabBar.setAttribute("aria-label", "Party Stash Tabs");
  tabBar.innerHTML = `
    <a class="tab-item active" data-tab="members" data-group="stash-tabs" role="tab" aria-selected="true">
      <i class="fa-solid fa-users"></i> ${game.i18n.localize("CRUCIBLE_PARTY_STASH.TabMembers")}
    </a>
    <a class="tab-item" data-tab="stash" data-group="stash-tabs" role="tab" aria-selected="false">
      <i class="fa-solid fa-box-open"></i> ${game.i18n.localize("CRUCIBLE_PARTY_STASH.TabStash")}
    </a>
  `;

  const existingHTML = contentArea.innerHTML;
  contentArea.innerHTML = "";
  contentArea.prepend(tabBar);

  // Members tab
  const membersTab = document.createElement("div");
  membersTab.className = "tab-content active";
  membersTab.dataset.tab = "members";
  membersTab.dataset.group = "stash-tabs";
  membersTab.innerHTML = existingHTML;
  contentArea.appendChild(membersTab);

  // Stash tab (async)
  const stashTab = document.createElement("div");
  stashTab.className = "tab-content";
  stashTab.dataset.tab = "stash";
  stashTab.dataset.group = "stash-tabs";
  _renderStashTab(stashTab, stashItems, isEditable).then(() => {
    contentArea.appendChild(stashTab);
    console.log(`${MODULE_ID} | Stash tab appended`);
  });

  // Tab switching
  tabBar.addEventListener("click", (ev) => {
    const link = ev.target.closest(".tab-item");
    if (!link) return;
    ev.preventDefault();
    const t = link.dataset.tab;
    if (!t) return;
    tabBar.querySelectorAll(".tab-item").forEach(l => {
      l.classList.toggle("active", l.dataset.tab === t);
      l.setAttribute("aria-selected", String(l.dataset.tab === t));
    });
    contentArea.querySelectorAll(".tab-content").forEach(c => {
      c.classList.toggle("active", c.dataset.tab === t);
    });
  });

  _activateStashDropListeners(stashTab, actor);
  _activateStashActionListeners(stashTab, actor);

  console.log(`${MODULE_ID} | Tab injection done`);
}

async function _renderStashTab(container, items, isEditable) {
  try {
    container.innerHTML = await renderTemplate(`modules/${MODULE_ID}/templates/stash-panel.hbs`, {
      items, isEmpty: items.length === 0, isEditable
    });
  } catch (err) {
    log.error("Template fallback:", err);
    if (!items.length) {
      container.innerHTML = `<div class="stash-empty"><p><i class="fa-solid fa-box-open"></i> ${game.i18n.localize("CRUCIBLE_PARTY_STASH.StashEmpty")}</p><p class="hint">${game.i18n.localize("CRUCIBLE_PARTY_STASH.DragHint")}</p></div>`;
    } else {
      const rows = items.map((item, i) =>
        `<li class="stash-item line-item" data-index="${i}" data-item-id="${item._id}" draggable="true">
          <img class="icon" src="${item.img}" alt="${item.name}" width="32" height="32">
          <div class="title"><h4>${item.name}</h4><span class="tag">${item.type}</span>${item.system?.quantity ? `<span class="tag">${game.i18n.localize("CRUCIBLE_PARTY_STASH.Quantity")}: ${item.system.quantity}</span>` : ""}</div>
          ${isEditable ? `<div class="controls"><a class="control stash-action" data-action="stash-give" data-index="${i}" data-tooltip="${game.i18n.localize("CRUCIBLE_PARTY_STASH.GiveToCharacter")}"><i class="fa-solid fa-hand-holding"></i></a><a class="control stash-action" data-action="stash-remove" data-index="${i}" data-tooltip="${game.i18n.localize("CRUCIBLE_PARTY_STASH.RemoveFromStash")}"><i class="fa-solid fa-trash"></i></a></div>` : ""}
        </li>`).join("");
      container.innerHTML = `<div class="stash-container"><p class="hint">${game.i18n.localize("CRUCIBLE_PARTY_STASH.DragHintStash")}</p><ol class="items-list stash-list scrollable">${rows}</ol></div>`;
    }
  }
}

/* ─── Strategy 1: Hook-based injection ─── */

Hooks.on("renderCrucibleGroupActorSheet", (app, element) => {
  console.log(`${MODULE_ID} | HOOK: renderCrucibleGroupActorSheet`);
  _onGroupSheetRender(app, element);
});

Hooks.on("renderActorSheetV2", (app, element) => {
  if (!app.actor || app.actor.type !== "group") return;
  console.log(`${MODULE_ID} | HOOK: renderActorSheetV2 (group)`);
  _onGroupSheetRender(app, element);
});

Hooks.on("renderActorSheet", (app, element) => {
  if (!app.actor || app.actor.type !== "group") return;
  if (!app.constructor?.name?.includes("Group")) return;
  console.log(`${MODULE_ID} | HOOK: renderActorSheet (group)`);
  _onGroupSheetRender(app, element);
});

Hooks.on("renderApplication", (app, element) => {
  if (!app.actor || app.actor.type !== "group") return;
  const n = app.constructor?.name || "";
  if (!n.includes("Group") && !n.includes("Crucible")) return;
  if (element.querySelector(".party-stash-tabs")) return;
  console.log(`${MODULE_ID} | HOOK: renderApplication (${n})`);
  _onGroupSheetRender(app, element);
});

/* ─── Strategy 2: Prototype patching (most reliable) ───
 * Patch the group sheet class _onRender after it's been registered. */

function _patchSheetClass() {
  const sheetClass = CONFIG.Actor.sheetClasses?.group?.["crucible"]?.cls
    || CONFIG.Actor.sheetClasses?.group?.find?.(s => s.cls)?.cls;
  if (!sheetClass) {
    console.log(`${MODULE_ID} | Sheet class not yet available, retrying...`);
    setTimeout(_patchSheetClass, 1000);
    return;
  }

  const name = sheetClass.name;
  console.log(`${MODULE_ID} | Patching ${name}._onRender`);

  const original = sheetClass.prototype._onRender;
  sheetClass.prototype._onRender = function(context, options) {
    console.log(`${MODULE_ID} | PATCHED _onRender for ${name}`);
    // Call original first
    const result = original?.call(this, context, options);
    // Now inject — use the rendered element
    _onGroupSheetRender(this, this.element);
    return result;
  };
  console.log(`${MODULE_ID} | Sheet class patched`);
}

/* ─── Strategy 3: MutationObserver (ultimate fallback) ─── */

function _setupMutationObserver() {
  setTimeout(() => {
    if (document.querySelector(".party-stash-tabs")) return;

    const observer = new MutationObserver(() => {
      if (document.querySelector(".party-stash-tabs")) return;
      const sheetEl = document.querySelector(".actor-group.application, .actor-group.sheet");
      if (!sheetEl) return;

      // Try to find the app instance from ui.windows
      const appId = sheetEl.id?.replace("application-", "");
      const app = appId ? ui.windows?.[appId] : null;
      if (!app) {
        console.log(`${MODULE_ID} | MO: found sheet but no app instance`);
        return;
      }
      console.log(`${MODULE_ID} | MO: detected group sheet`);
      _onGroupSheetRender(app, sheetEl);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Check immediately too
    const sheetEl = document.querySelector(".actor-group.application, .actor-group.sheet");
    if (sheetEl) {
      const appId = sheetEl.id?.replace("application-", "");
      const app = appId ? ui.windows?.[appId] : null;
      if (app) {
        console.log(`${MODULE_ID} | MO: initial sheet found`);
        _onGroupSheetRender(app, sheetEl);
      }
    }
  }, 3000);
}

/* ─── Drop: accept items into stash ─── */

function _activateStashDropListeners(stashTab, groupActor) {
  stashTab.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    stashTab.classList.add("drag-over");
  });
  stashTab.addEventListener("dragleave", (ev) => {
    if (!stashTab.contains(ev.relatedTarget)) stashTab.classList.remove("drag-over");
  });
  stashTab.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    stashTab.classList.remove("drag-over");
    let data;
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
    if (data.type !== "Item" || data.fromStash) return;

    const item = await Item.implementation.fromDropData(data);
    if (!item) return;

    const itemData = item.toObject();
    const currentStash = _getStash(groupActor);
    const cap = _checkStashCapacity(currentStash);
    if (!cap.ok) {
      ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: cap.max }));
      return;
    }

    const src = item.parent;
    let del = false;
    if (src instanceof Actor && src.id !== groupActor.id) {
      if (game.settings.get(MODULE_ID, "confirmTransfer")) {
        try { del = await foundry.applications.api.DialogV2.confirm({
          window: { title: game.i18n.localize("CRUCIBLE_PARTY_STASH.MoveToStash"), icon: "fa-solid fa-box-open" },
          content: game.i18n.format("CRUCIBLE_PARTY_STASH.MoveConfirm", { name: item.name, actor: src.name }),
          modal: true, rejectClose: false,
          yes: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Move"), icon: "fa-solid fa-box-open", callback: () => true },
          no: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.CopyOnly"), icon: "fa-solid fa-copy", callback: () => false }
        }); } catch { return; }
      } else { del = true; }
      if (del) { const s = game.actors.get(src.id); if (s) await s.deleteEmbeddedDocuments("Item", [item.id]); }
    }

    itemData._stashId = foundry.utils.randomID();
    currentStash.push(itemData);
    await _setStash(groupActor, currentStash);
    ui.notifications.info(`${item.name} added to party stash.`);
  });
}

/* ─── Click: Give / Remove ─── */

function _activateStashActionListeners(stashTab, groupActor) {
  stashTab.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    ev.preventDefault();
    const action = el.dataset.action;
    const index = Number(el.dataset.index);
    let stash = _getStash(groupActor);
    if (action === "stash-remove") {
      const r = stash.splice(index, 1)[0];
      await _setStash(groupActor, stash);
      ui.notifications.info(`${r?.name ?? "Item"} removed.`);
      return;
    }
    if (action === "stash-give") {
      const members = (groupActor.system.members ?? []).filter(m => m.actor instanceof Actor);
      if (!members.length) { ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoMembers")); return; }
      const choices = {};
      for (const m of members) choices[m.actorId] = m.actor.name;
      const recipient = await _pickRecipient(choices);
      if (!recipient) return;
      const target = game.actors.get(recipient);
      if (!target) { ui.notifications.error("Recipient not found."); return; }
      const itemData = stash[index];
      if (!itemData) return;
      const d = foundry.utils.deepClone(itemData);
      delete d._id; delete d._stashId; delete d.flags?.[MODULE_ID];
      await target.createEmbeddedDocuments("Item", [d]);
      stash.splice(index, 1);
      await _setStash(groupActor, stash);
      ui.notifications.info(`${itemData.name} given to ${target.name}.`);
    }
  });

  stashTab.addEventListener("dragstart", (ev) => {
    const li = ev.target.closest(".stash-item[data-index]");
    if (!li) return;
    const index = Number(li.dataset.index);
    const stash = _getStash(groupActor);
    const itemData = stash[index];
    if (!itemData) return;
    ev.dataTransfer.setData("text/plain", JSON.stringify({
      type: "Item", data: itemData, fromStash: true, stashIndex: index, groupActorId: groupActor.id
    }));
    ev.dataTransfer.dropEffect = "move";
  });
}

async function _pickRecipient(choices) {
  const field = new foundry.data.fields.StringField({
    label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Recipient"), choices, required: true, blank: false
  });
  const content = document.createElement("div");
  content.style.cssText = "padding: 0.5rem;";
  content.append(field.toFormGroup({}, { name: "recipient" }));
  try {
    return await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("CRUCIBLE_PARTY_STASH.GiveItem"), icon: "fa-solid fa-hand-holding" },
      content,
      ok: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Give"), icon: "fa-solid fa-check", callback: (e, b, fd) => new FormData(b.form || fd).get("recipient") || null },
      rejectClose: false
    });
  } catch { return null; }
}

/* ─── Return: stash → character sheet (V1 hook) ─── */

Hooks.on("dropActorSheetData", async (targetActor, sheet, data) => {
  if (!data?.fromStash || data.groupActorId === targetActor.id) return;
  const itemData = foundry.utils.deepClone(data.data);
  delete itemData._id; delete itemData._stashId; delete itemData.flags?.[MODULE_ID];
  const created = await targetActor.createEmbeddedDocuments("Item", [itemData]);
  if (!created.length) return;
  const groupActor = game.actors.get(data.groupActorId);
  if (!groupActor) return;
  const stash = _getStash(groupActor);
  if (data.stashIndex >= 0 && data.stashIndex < stash.length) {
    stash.splice(data.stashIndex, 1);
    await _setStash(groupActor, stash);
  }
  ui.notifications.info(`${itemData.name} moved to ${targetActor.name}.`);
});

/* ─── Return: V2 hero sheet drop ─── */

Hooks.on("renderActorSheetV2", (app, element) => {
  if (!(app.actor?.type === "hero" || app.actor?.type === "adversary")) return;
  element.addEventListener("drop", async (ev) => {
    let data;
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
    if (!data?.fromStash || data.groupActorId === app.actor.id) return;
    ev.preventDefault(); ev.stopPropagation();
    const itemData = foundry.utils.deepClone(data.data);
    delete itemData._id; delete itemData._stashId; delete itemData.flags?.[MODULE_ID];
    const created = await app.actor.createEmbeddedDocuments("Item", [itemData]);
    if (!created.length) return;
    const groupActor = game.actors.get(data.groupActorId);
    if (!groupActor) return;
    const stash = _getStash(groupActor);
    if (data.stashIndex >= 0 && data.stashIndex < stash.length) {
      stash.splice(data.stashIndex, 1);
      await _setStash(groupActor, stash);
    }
    ui.notifications.info(`${itemData.name} moved to ${app.actor.name}.`);
  }, true);
});

/* ─── Ready ─── */

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready. FVTT ${game.version}, Crucible ${game.system?.version}`);
  const groups = game.actors?.filter(a => a.type === "group") ?? [];
  for (const g of groups) console.log(`${MODULE_ID} | Group: ${g.name} (${(g.getFlag(MODULE_ID, "stash") ?? []).length} stash)`);
  console.log(`${MODULE_ID} | Debug: CRUCIBLE_STASH_DEBUG.help()`);

  // Activate strategies 2 & 3
  _patchSheetClass();
  _setupMutationObserver();
});