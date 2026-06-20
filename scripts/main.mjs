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
    console.group(`[${MODULE_ID}] Debug Status`);
    console.log("Module loaded:", true);
    console.log("Settings registered:",
      game.settings.settings.has(`${MODULE_ID}.stashCapacity`) &&
      game.settings.settings.has(`${MODULE_ID}.confirmTransfer`));
    console.log("Current world:", game.world?.title);
    console.log("System:", game.system?.id, game.system?.version);
    console.log("Foundry Version:", game.version);
    console.groupEnd();
  },

  groups() {
    const groups = game.actors?.filter(a => a.type === "group") ?? [];
    if (!groups.length) {
      console.warn(`[${MODULE_ID}] No group actors found in world.`);
      return;
    }
    for (const g of groups) {
      const stash = g.getFlag(MODULE_ID, "stash") ?? [];
      console.group(`Group: ${g.name} (${g.id})`);
      console.log("Stash items:", stash.length);
      console.log("Stash data:", JSON.parse(JSON.stringify(stash)));
      console.log("Sheet open:", !!g.sheet);
      console.log("Sheet class:", g.sheet?.constructor?.name);
      console.groupEnd();
    }
    return groups;
  },

  async addTestItem() {
    const group = game.actors?.find(a => a.type === "group");
    if (!group) return console.error(`[${MODULE_ID}] No group actor found`);
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
    console.log(`[${MODULE_ID}] Added test item to ${group.name}`);
  },

  hooks() {
    console.group(`[${MODULE_ID}] Hook Diagnostics`);
    const hookNames = [
      "init", "ready", "preloadTemplates",
      "renderCrucibleGroupActorSheet",
      "renderActorSheetV2",
      "dropActorSheetData",
      "renderActorSheet",
      "renderApplication"
    ];
    for (const name of hookNames) {
      const handlers = Hooks._hooks?.[name];
      const ourHandlers = handlers?.filter(h =>
        h.toString().includes(MODULE_ID) ||
        h.toString().includes("crucible-party-stash")
      );
      console.log(`${name}: ${handlers?.length ?? 0} total, ${ourHandlers?.length ?? 0} from our module`);
    }
    console.groupEnd();
  },

  inspectSheet() {
    const sheetEl = document.querySelector(".actor-group.application");
    if (!sheetEl) {
      console.warn(`[${MODULE_ID}] No .actor-group.application element found in DOM`);
      const allSheets = document.querySelectorAll(".application");
      console.log(`Found ${allSheets.length} application elements in DOM`);
      for (const s of allSheets) {
        console.log(`  - classes: ${s.className}, id: ${s.id}`);
      }
      return;
    }
    console.group(`[${MODULE_ID}] Sheet DOM Inspection`);
    console.log("Sheet element classes:", sheetEl.className);
    const sheetBody = sheetEl.querySelector(".sheet-body");
    console.log("Has .sheet-body:", !!sheetBody);
    if (sheetBody) {
      console.log("Sheet-body children:", sheetBody.children.length);
      console.log("Has .party-stash-tabs:", !!sheetBody.querySelector(".party-stash-tabs"));
      console.log("Has .tab-content:", !!sheetBody.querySelector(".tab-content"));
      console.log("HTML (first 500 chars):", sheetBody.innerHTML.substring(0, 500));
    }
    let found = false;
    for (const el of [sheetEl, ...sheetEl.querySelectorAll("*")]) {
      if (el.classList?.contains("sheet-body")) {
        console.log("Found .sheet-body at:", el.tagName, el.className);
        found = true;
      }
    }
    if (!found) console.log("Did NOT find .sheet-body anywhere in sheet");
    console.groupEnd();
  },

  help() {
    console.log(`[${MODULE_ID}] Debug Commands:`);
    console.log("  .status()        — Show module registration state");
    console.log("  .groups()        — List all group actors and their stash");
    console.log("  .addTestItem()   — Add a test weapon to first group's stash");
    console.log("  .hooks()         — Show hook registration diagnostics");
    console.log("  .inspectSheet()  — Inspect the group sheet DOM");
    console.log("  .logging = false — Disable debug logging");
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
  log.info("Initializing");

  game.settings.register(MODULE_ID, "stashCapacity", {
    name: "CRUCIBLE_PARTY_STASH.StashCapacity",
    hint: "CRUCIBLE_PARTY_STASH.StashCapacityHint",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, "confirmTransfer", {
    name: "CRUCIBLE_PARTY_STASH.ConfirmTransfer",
    hint: "CRUCIBLE_PARTY_STASH.ConfirmTransferHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  log.info("Settings registered");
});

/* ─── Template Preloading ─── */

Hooks.once("preloadTemplates", async () => {
  const path = `modules/${MODULE_ID}/templates/stash-panel.hbs`;
  log.info("Preloading template:", path);
  try {
    await loadTemplates([path]);
    log.info("Template preloaded successfully");
  } catch (err) {
    log.error("Failed to preload template:", err);
  }
});

/* ─── Core Tab Injection ─── */

function _onGroupSheetRender(app, element) {
  const actor = app.actor;
  if (!actor || actor.type !== "group") {
    log.info("Skipping non-group actor:", actor?.name, actor?.type);
    return;
  }

  const constructorName = app.constructor?.name;
  log.info("Group sheet rendered:", constructorName, "actor:", actor.name);

  if (element.querySelector(".party-stash-tabs")) {
    log.info("Tabs already injected, skipping");
    return;
  }

  const isEditable = app.isEditable;
  const stashItems = _getStash(actor);
  log.info(`Stash has ${stashItems.length} items`);

  // Locate sheet-body with multiple fallback strategies
  let sheetBody = element.querySelector(".sheet-body");
  if (!sheetBody) {
    log.warn("No .sheet-body via querySelector, trying alternatives");
    // Check the window-content for the actual rendered HTML
    const content = element.querySelector(".window-content, [data-application-part]");
    if (content) {
      sheetBody = content.querySelector(".sheet-body") || content;
      log.info("Found via content el, sheetBody:", !!sheetBody, sheetBody?.className);
    }
  }
  if (!sheetBody) {
    // Maybe element itself IS the sheet body container
    const candidate = element.querySelector(".standard-form, section:first-child");
    if (candidate) {
      sheetBody = candidate;
      log.info("Using fallback container:", candidate.className);
    }
  }
  if (!sheetBody) {
    log.error("Cannot find sheet body — DOM unexpected. Element:", element.tagName, element.className);
    log.info("Inner HTML (first 800):", element.innerHTML?.substring(0, 800));
    return;
  }

  log.info("Sheet-body found, children before:", sheetBody.children.length);

  // Build tab bar
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

  // Save original content, wrap in Members tab
  const existingHTML = sheetBody.innerHTML;
  sheetBody.innerHTML = "";
  sheetBody.prepend(tabBar);

  const membersTab = document.createElement("div");
  membersTab.className = "tab-content active";
  membersTab.dataset.tab = "members";
  membersTab.dataset.group = "stash-tabs";
  membersTab.innerHTML = existingHTML;
  sheetBody.appendChild(membersTab);

  log.info("Members tab created");

  // Build Stash tab (async, but no need to block the hook handler)
  const stashTab = document.createElement("div");
  stashTab.className = "tab-content";
  stashTab.dataset.tab = "stash";
  stashTab.dataset.group = "stash-tabs";

  _renderStashTab(stashTab, stashItems, isEditable).then(() => {
    sheetBody.appendChild(stashTab);
    log.info("Stash tab appended");
  });

  // Tab click handler
  tabBar.addEventListener("click", (ev) => {
    const tabLink = ev.target.closest(".tab-item");
    if (!tabLink) return;
    ev.preventDefault();
    const targetTab = tabLink.dataset.tab;
    if (!targetTab) return;

    tabBar.querySelectorAll(".tab-item").forEach(t => {
      const active = t.dataset.tab === targetTab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    });
    sheetBody.querySelectorAll(".tab-content").forEach(c => {
      c.classList.toggle("active", c.dataset.tab === targetTab);
    });
    log.info("Tab switched:", targetTab);
  });

  // Activate DnD
  _activateStashDropListeners(stashTab, actor);
  _activateStashActionListeners(stashTab, actor);

  log.info("Tab injection complete");
}

async function _renderStashTab(container, items, isEditable) {
  try {
    container.innerHTML = await renderTemplate(`modules/${MODULE_ID}/templates/stash-panel.hbs`, {
      items, isEmpty: items.length === 0, isEditable
    });
  } catch (err) {
    log.error("Template render failed, using fallback:", err);
    if (!items.length) {
      container.innerHTML = `<div class="stash-empty"><p><i class="fa-solid fa-box-open"></i> ${game.i18n.localize("CRUCIBLE_PARTY_STASH.StashEmpty")}</p><p class="hint">${game.i18n.localize("CRUCIBLE_PARTY_STASH.DragHint")}</p></div>`;
    } else {
      const rows = items.map((item, i) => `
        <li class="stash-item line-item" data-index="${i}" data-item-id="${item._id}" draggable="true">
          <img class="icon" src="${item.img}" alt="${item.name}" width="32" height="32">
          <div class="title"><h4>${item.name}</h4><span class="tag">${item.type}</span>${item.system?.quantity ? `<span class="tag">${game.i18n.localize("CRUCIBLE_PARTY_STASH.Quantity")}: ${item.system.quantity}</span>` : ""}</div>
          ${isEditable ? `<div class="controls"><a class="control stash-action" data-action="stash-give" data-index="${i}" data-tooltip="${game.i18n.localize("CRUCIBLE_PARTY_STASH.GiveToCharacter")}"><i class="fa-solid fa-hand-holding"></i></a><a class="control stash-action" data-action="stash-remove" data-index="${i}" data-tooltip="${game.i18n.localize("CRUCIBLE_PARTY_STASH.RemoveFromStash")}"><i class="fa-solid fa-trash"></i></a></div>` : ""}
        </li>`).join("");
      container.innerHTML = `<div class="stash-container"><p class="hint">${game.i18n.localize("CRUCIBLE_PARTY_STASH.DragHintStash")}</p><ol class="items-list stash-list scrollable">${rows}</ol></div>`;
    }
  }
}

/* ─── Hook Registrations (multiple fallbacks) ─── */

// Primary: class-specific hook
Hooks.on("renderCrucibleGroupActorSheet", (app, element, context, options) => {
  log.info("HIT: renderCrucibleGroupActorSheet");
  _onGroupSheetRender(app, element);
});

// Fallback 1: generic V2 actor sheet hook
Hooks.on("renderActorSheetV2", (app, element, context, options) => {
  if (!app.actor || app.actor.type !== "group") return;
  log.info("HIT: renderActorSheetV2 (group)");
  _onGroupSheetRender(app, element);
});

// Fallback 2: legacy V1 actor sheet hook (for V2 sheets that fall through)
Hooks.on("renderActorSheet", (app, element, context) => {
  if (!app.actor || app.actor.type !== "group") return;
  if (app.constructor?.name?.includes("SheetV2") || app.constructor?.name?.includes("Sheet2")) return;
  log.info("HIT: renderActorSheet (group, V1)");
  _onGroupSheetRender(app, element);
});

// Fallback 3: generic renderApplication hook (last resort)
Hooks.on("renderApplication", (app, element) => {
  if (!app.actor || app.actor.type !== "group") return;
  const name = app.constructor?.name || "";
  if (!name.includes("Group") && !name.includes("Crucible")) return;
  if (element.querySelector(".party-stash-tabs")) return;
  log.info("HIT: renderApplication (fallback for", name, ")");
  _onGroupSheetRender(app, element);
});

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
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); }
    catch { log.warn("Drop: unparseable data"); return; }

    if (data.type !== "Item") return;
    if (data.fromStash) return;

    const item = await Item.implementation.fromDropData(data);
    if (!item) { log.warn("Drop: could not resolve item"); return; }

    const itemData = item.toObject();
    const currentStash = _getStash(groupActor);
    const capacity = _checkStashCapacity(currentStash);
    if (!capacity.ok) {
      ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: capacity.max }));
      return;
    }

    const sourceActor = item.parent;
    let shouldDelete = false;
    if (sourceActor instanceof Actor && sourceActor.id !== groupActor.id) {
      if (game.settings.get(MODULE_ID, "confirmTransfer")) {
        try {
          shouldDelete = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize("CRUCIBLE_PARTY_STASH.MoveToStash"), icon: "fa-solid fa-box-open" },
            content: game.i18n.format("CRUCIBLE_PARTY_STASH.MoveConfirm", { name: item.name, actor: sourceActor.name }),
            modal: true, rejectClose: false,
            yes: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Move"), icon: "fa-solid fa-box-open", callback: () => true },
            no: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.CopyOnly"), icon: "fa-solid fa-copy", callback: () => false }
          });
        } catch { return; }
      } else { shouldDelete = true; }
      if (shouldDelete) {
        const src = game.actors.get(sourceActor.id);
        if (src) await src.deleteEmbeddedDocuments("Item", [item.id]);
      }
    }

    itemData._stashId = foundry.utils.randomID();
    currentStash.push(itemData);
    await _setStash(groupActor, currentStash);
    log.info(`${item.name} stashed`);
    ui.notifications.info(`${item.name} added to party stash.`);
  });
}

/* ─── Click actions: Give / Remove ─── */

function _activateStashActionListeners(stashTab, groupActor) {
  stashTab.addEventListener("click", async (ev) => {
    const actionEl = ev.target.closest("[data-action]");
    if (!actionEl) return;
    ev.preventDefault();
    const action = actionEl.dataset.action;
    const index = Number(actionEl.dataset.index);
    let stash = _getStash(groupActor);

    if (action === "stash-remove") {
      const removed = stash.splice(index, 1)[0];
      await _setStash(groupActor, stash);
      ui.notifications.info(`${removed?.name ?? "Item"} removed from stash.`);
      return;
    }

    if (action === "stash-give") {
      const members = (groupActor.system.members ?? []).filter(m => m.actor instanceof Actor);
      if (!members.length) { ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoMembers")); return; }
      const choices = {};
      for (const m of members) choices[m.actorId] = m.actor.name;
      const recipient = await _pickRecipient(choices);
      if (!recipient) return;
      const targetActor = game.actors.get(recipient);
      if (!targetActor) { ui.notifications.error("Recipient not found."); return; }
      const itemData = stash[index];
      if (!itemData) return;
      const createData = foundry.utils.deepClone(itemData);
      delete createData._id; delete createData._stashId; delete createData.flags?.[MODULE_ID];
      await targetActor.createEmbeddedDocuments("Item", [createData]);
      stash.splice(index, 1);
      await _setStash(groupActor, stash);
      ui.notifications.info(`${itemData.name} given to ${targetActor.name}.`);
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

/* ─── Return path: stash item → character sheet (V1 hook) ─── */

Hooks.on("dropActorSheetData", async (targetActor, sheet, data) => {
  if (!data?.fromStash || data.groupActorId === targetActor.id) return;
  log.info("dropActorSheetData: returning item from stash");

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

/* ─── Return path: V2 hero sheet drop interception ─── */

Hooks.on("renderActorSheetV2", (app, element, context, options) => {
  if (!(app.actor?.type === "hero" || app.actor?.type === "adversary")) return;

  element.addEventListener("drop", async (ev) => {
    let data;
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); }
    catch { return; }
    if (!data?.fromStash || data.groupActorId === app.actor.id) return;
    ev.preventDefault();
    ev.stopPropagation();
    log.info("V2 hero sheet: stash item received");

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

/* ─── Ready: diagnostics ─── */

Hooks.once("ready", () => {
  log.info("Ready. FVTT:", game.version, "System:", game.system?.id, game.system?.version);
  const groups = game.actors?.filter(a => a.type === "group") ?? [];
  log.info(`Group actors: ${groups.length}`);
  for (const g of groups) log.info(`  ${g.name}: ${(g.getFlag(MODULE_ID, "stash") ?? []).length} items`);
  log.info("Debug: window.CRUCIBLE_STASH_DEBUG.help()");
});

  // Remove from the group stash
  const groupActor = game.actors.get(data.groupActorId);
  if (!groupActor) return;

  const stash = _getStash(groupActor);
  if (data.stashIndex >= 0 && data.stashIndex < stash.length) {
    stash.splice(data.stashIndex, 1);
    await _setStash(groupActor, stash);
  }

  ui.notifications.info(`${itemData.name} moved to ${targetActor.name}.`);
});

/* ─── Also handle direct drops onto V2 hero sheets ───
 * Foundry V14 ApplicationV2 sheets may not fire dropActorSheetData.
 * We patch the _onDrop method of Crucible hero sheets as a fallback. */

Hooks.on("renderActorSheetV2", (app, element, context, options) => {
  // Only target Crucible hero/adventurer sheets (not the group sheet itself)
  if (!(app.actor?.type === "hero" || app.actor?.type === "adversary")) return;
  if (app.actor.type === "group") return;

  // We attach a drop handler to catch stash drags that the core hook misses
  element.addEventListener("drop", async (ev) => {
    let data;
    try {
      data = JSON.parse(ev.dataTransfer.getData("text/plain"));
    } catch {
      return;
    }

    if (!data?.fromStash) return;
    if (data.groupActorId === app.actor.id) return;

    // Prevent default handling and do our own
    ev.preventDefault();
    ev.stopPropagation();

    const itemData = foundry.utils.deepClone(data.data);
    delete itemData._id;
    delete itemData._stashId;
    delete itemData.flags?.[MODULE_ID];

    const created = await app.actor.createEmbeddedDocuments("Item", [itemData]);
    if (!created.length) return;

    // Remove from stash
    const groupActor = game.actors.get(data.groupActorId);
    if (!groupActor) return;

    const stash = _getStash(groupActor);
    if (data.stashIndex >= 0 && data.stashIndex < stash.length) {
      stash.splice(data.stashIndex, 1);
      await _setStash(groupActor, stash);
    }

    ui.notifications.info(`${itemData.name} moved to ${app.actor.name}.`);
  }, true); // capture phase to intercept before sheet's own handler
});