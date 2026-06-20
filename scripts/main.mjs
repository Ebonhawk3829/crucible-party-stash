const MODULE_ID = "crucible-party-stash";

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

Hooks.once("init", async () => {
  const path = `modules/${MODULE_ID}/templates/stash-panel.hbs`;
  await foundry.applications.handlebars.loadTemplates([path]);
});

/* ─── Render the stash panel HTML ─── */

async function _renderStashHTML(items, isEditable) {
  try {
    return await foundry.applications.handlebars.renderTemplate(
      `modules/${MODULE_ID}/templates/stash-panel.hbs`,
      { items, isEmpty: items.length === 0, isEditable }
    );
  } catch (err) {
    console.error(`${MODULE_ID} | Template render failed, using fallback`, err);
    // Inline fallback if template fails
    if (!items.length) {
      return `<div class="stash-empty">
        <p><i class="fa-solid fa-box-open"></i> The party stash is empty.</p>
        <p class="hint">Drag items here from character sheets.</p>
      </div>`;
    }
    const rows = items.map((item, i) => `
      <li class="stash-item line-item" data-index="${i}" data-item-id="${item._id}" draggable="true">
        <img class="icon" src="${item.img}" alt="${item.name}" width="32" height="32">
        <div class="title"><h4>${item.name}</h4><span class="tag">${item.type}</span></div>
        ${isEditable ? `<div class="controls">
          <a class="control" data-stash-action="give" data-index="${i}"><i class="fa-solid fa-hand-holding"></i></a>
          <a class="control" data-stash-action="remove" data-index="${i}"><i class="fa-solid fa-trash"></i></a>
        </div>` : ""}
      </li>`).join("");
    return `<div class="stash-container">
      <p class="hint">Drag items here, or drag them back to a character.</p>
      <ol class="items-list stash-list scrollable">${rows}</ol>
    </div>`;
  }
}

/* ─── Core Injection ───
 *
 * NOTE: CrucibleGroupActorSheet uses root: true on its single PARTS entry.
 * Foundry strips the template's outer <section class="sheet-body"> and places
 * its children directly inside .window-content. We target .window-content
 * directly, not a non-existent section.sheet-body. */

Hooks.on("renderCrucibleGroupActorSheet", async (app, element, context, options) => {
  const actor = app.actor;
  if (!actor || actor.type !== "group") return;

  // element is the <form> app frame. window-content is inside it.
  const windowContent = element.querySelector(".window-content");
  if (!windowContent) return;

  const isEditable = app.isEditable;
  const stashItems = _getStash(actor);
  const activeTab = app._stashActiveTab || "members";

  // Build tab bar
  const tabBar = document.createElement("nav");
  tabBar.className = "party-stash-tabs";
  tabBar.innerHTML = `
    <a class="party-stash-tab-item ${activeTab === "members" ? "active" : ""}" 
       data-stash-tab="members">
      <i class="fa-solid fa-users"></i> ${game.i18n.localize("CRUCIBLE_PARTY_STASH.TabMembers")}
    </a>
    <a class="party-stash-tab-item ${activeTab === "stash" ? "active" : ""}" 
       data-stash-tab="stash">
      <i class="fa-solid fa-box-open"></i> ${game.i18n.localize("CRUCIBLE_PARTY_STASH.TabStash")}
      ${stashItems.length ? `<span class="stash-count">${stashItems.length}</span>` : ""}
    </a>
  `;

  // Capture ALL current children of window-content (the original sheet content)
  const originalChildren = Array.from(windowContent.childNodes);

  // Members tab wraps the original content
  const membersTab = document.createElement("div");
  membersTab.className = `party-stash-panel ${activeTab === "members" ? "active" : ""}`;
  membersTab.dataset.stashTab = "members";
  for (const child of originalChildren) {
    membersTab.appendChild(child);
  }

  // Stash tab
  const stashTab = document.createElement("div");
  stashTab.className = `party-stash-panel ${activeTab === "stash" ? "active" : ""}`;
  stashTab.dataset.stashTab = "stash";
  stashTab.innerHTML = await _renderStashHTML(stashItems, isEditable);

  // Rebuild window-content: tab bar, then the two panels
  windowContent.innerHTML = "";
  windowContent.appendChild(tabBar);
  windowContent.appendChild(membersTab);
  windowContent.appendChild(stashTab);

  // ─── Tab switching ───
  tabBar.addEventListener("click", (ev) => {
    const link = ev.target.closest("[data-stash-tab]");
    if (!link) return;
    ev.preventDefault();
    const t = link.dataset.stashTab;
    app._stashActiveTab = t;
    tabBar.querySelectorAll(".party-stash-tab-item").forEach(l => {
      l.classList.toggle("active", l.dataset.stashTab === t);
    });
    windowContent.querySelectorAll(".party-stash-panel").forEach(p => {
      p.classList.toggle("active", p.dataset.stashTab === t);
    });
  });

  // ─── Stash listeners ───
  _activateStashDropListeners(stashTab, actor);
  _activateStashActionListeners(stashTab, actor);
});

/* ─── Hero/Adversary sheet: intercept stash drops ─── */

Hooks.on("renderActorSheetV2", (app, element) => {
  if (app.actor?.type === "hero" || app.actor?.type === "adversary") {
    _setupHeroDropInterception(app, element);
  }
});

/* ─── Drop: accept items INTO the stash ─── */

function _activateStashDropListeners(stashTab, groupActor) {
  stashTab.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    stashTab.classList.add("drag-over");
  });

  stashTab.addEventListener("dragleave", (ev) => {
    if (!stashTab.contains(ev.relatedTarget)) {
      stashTab.classList.remove("drag-over");
    }
  });

  stashTab.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation(); // Prevent the sheet's own drop handler from firing
    stashTab.classList.remove("drag-over");

    let data;
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
    if (data.type !== "Item" || data.fromStash) return;

    const item = await Item.implementation.fromDropData(data);
    if (!item) return;

    const currentStash = _getStash(groupActor);
    const cap = _checkStashCapacity(currentStash);
    if (!cap.ok) {
      ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: cap.max }));
      return;
    }

    const src = item.parent;
    let shouldDelete = false;

    if (src instanceof Actor && src.id !== groupActor.id) {
      if (game.settings.get(MODULE_ID, "confirmTransfer")) {
        try {
          shouldDelete = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize("CRUCIBLE_PARTY_STASH.MoveToStash") },
            content: `<p>${game.i18n.format("CRUCIBLE_PARTY_STASH.MoveConfirm", { name: item.name, actor: src.name })}</p>`,
            yes: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Move"), icon: "fa-solid fa-box-open" },
            no: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.CopyOnly"), icon: "fa-solid fa-copy" }
          });
        } catch { return; }
      } else {
        shouldDelete = true;
      }
      if (shouldDelete) {
        await src.deleteEmbeddedDocuments("Item", [item.id]);
      }
    }

    const itemData = item.toObject();
    itemData._stashId = foundry.utils.randomID();
    currentStash.push(itemData);

    // Set the active tab to stash BEFORE the flag update triggers re-render
    const sheet = groupActor.sheet;
    if (sheet) sheet._stashActiveTab = "stash";

    await _setStash(groupActor, currentStash);
    ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemAdded", { name: item.name }));
  });
}

/* ─── Click: Give / Remove ───
 * IMPORTANT: We use data-stash-action instead of data-action to avoid
 * collision with Foundry's ApplicationV2 action system, which would
 * intercept and swallow clicks on data-action elements. */

function _activateStashActionListeners(stashTab, groupActor) {
  // Prevent draggable parent <li> from eating clicks on control buttons
  stashTab.addEventListener("mousedown", (ev) => {
    const control = ev.target.closest("[data-stash-action]");
    if (control) {
      console.log("CRUCIBLE STASH [mousedown] on control:", control.dataset.stashAction, "index:", control.dataset.index, "target:", ev.target.className, "currentTarget:", ev.currentTarget.className);
      ev.stopPropagation();
    } else {
      // Log clicks on the draggable <li> itself to see if drag starts
      const li = ev.target.closest(".stash-item");
      if (li) {
        console.log("CRUCIBLE STASH [mousedown] on .stash-item (not a control)");
      }
    }
  });

  stashTab.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-stash-action]");
    if (!el) {
      console.log("CRUCIBLE STASH [click] — no data-stash-action target found, target:", ev.target.className, "currentTarget:", ev.currentTarget.className);
      return;
    }
    console.log("CRUCIBLE STASH [click] — action:", el.dataset.stashAction, "index:", el.dataset.index, "target:", ev.target.className);
    ev.preventDefault();
    ev.stopPropagation();

    const action = el.dataset.stashAction;
    const index = Number(el.dataset.index);
    const stash = _getStash(groupActor);

    if (action === "remove") {
      const removed = stash.splice(index, 1)[0];
      const sheet = groupActor.sheet;
      if (sheet) sheet._stashActiveTab = "stash";
      await _setStash(groupActor, stash);
      ui.notifications.info(`${removed?.name ?? "Item"} removed from stash.`);
      return;
    }

    if (action === "give") {
      console.log("CRUCIBLE STASH [give] system.members raw:", groupActor.system.members);
      console.log("CRUCIBLE STASH [give] type:", typeof groupActor.system.members,
                  "isArray:", Array.isArray(groupActor.system.members));
      const members = (groupActor.system.members ?? []).filter(m => m.actor instanceof Actor);
      if (!members.length) {
        ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoMembers"));
        return;
      }

      const choices = {};
      for (const m of members) choices[m.actorId] = m.actor.name;
      const recipient = await _pickRecipient(choices);
      if (!recipient) return;

      const target = game.actors.get(recipient);
      if (!target) { ui.notifications.error("Recipient not found."); return; }

      const itemData = stash[index];
      if (!itemData) return;

      const cleanData = foundry.utils.deepClone(itemData);
      delete cleanData._id;
      delete cleanData._stashId;
      await target.createEmbeddedDocuments("Item", [cleanData]);

      stash.splice(index, 1);
      const sheet = groupActor.sheet;
      if (sheet) sheet._stashActiveTab = "stash";
      await _setStash(groupActor, stash);
      ui.notifications.info(`${itemData.name} given to ${target.name}.`);
    }
  });

  // Drag items OUT of the stash
  stashTab.addEventListener("dragstart", (ev) => {
    // Don't let control buttons (give/remove) trigger a drag
    if (ev.target.closest("[data-stash-action]")) {
      ev.preventDefault();
      return;
    }
    const li = ev.target.closest(".stash-item[data-index]");
    if (!li) return;
    const index = Number(li.dataset.index);
    const stash = _getStash(groupActor);
    const itemData = stash[index];
    if (!itemData) return;
    ev.dataTransfer.setData("text/plain", JSON.stringify({
      type: "Item",
      data: itemData,
      fromStash: true,
      stashIndex: index,
      groupActorId: groupActor.id
    }));
  });
}

/* ─── Recipient picker dialog ─── */

async function _pickRecipient(choices) {
  const field = new foundry.data.fields.StringField({
    label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Recipient"),
    choices,
    required: true,
    blank: false
  });
  const content = document.createElement("div");
  content.style.padding = "0.5rem";
  content.append(field.toFormGroup({}, { name: "recipient" }));

  try {
    return await foundry.applications.api.DialogV2.prompt({
      window: {
        title: game.i18n.localize("CRUCIBLE_PARTY_STASH.GiveItem"),
        icon: "fa-solid fa-hand-holding"
      },
      content,
      ok: {
        label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Give"),
        icon: "fa-solid fa-check",
        callback: (event, button, dialog) => {
          // dialog is the dialog's HTMLElement
          const select = dialog.querySelector("select[name=recipient]");
          return select?.value || null;
        }
      },
      rejectClose: false
    });
  } catch { return null; }
}

/* ─── Stash → character (V1 dropActorSheetData hook) ─── */

Hooks.on("dropActorSheetData", async (targetActor, sheet, data) => {
  if (!data?.fromStash || data.groupActorId === targetActor.id) return;

  const itemData = foundry.utils.deepClone(data.data);
  delete itemData._id;
  delete itemData._stashId;

  const created = await targetActor.createEmbeddedDocuments("Item", [itemData]);
  if (!created.length) return;

  const groupActor = game.actors.get(data.groupActorId);
  if (!groupActor) return;

  const stash = _getStash(groupActor);
  if (data.stashIndex >= 0 && data.stashIndex < stash.length) {
    stash.splice(data.stashIndex, 1);
    const gSheet = groupActor.sheet;
    if (gSheet) gSheet._stashActiveTab = "stash";
    await _setStash(groupActor, stash);
  }
  ui.notifications.info(`${itemData.name} moved to ${targetActor.name}.`);
});

/* ─── Stash → V2 hero sheet (direct drop interception) ─── */

function _setupHeroDropInterception(app, element) {
  if (element.dataset.stashDropReady) return;
  element.dataset.stashDropReady = "1";

  element.addEventListener("drop", async (ev) => {
    let data;
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
    if (!data?.fromStash || data.groupActorId === app.actor?.id) return;

    ev.preventDefault();
    ev.stopPropagation();

    const itemData = foundry.utils.deepClone(data.data);
    delete itemData._id;
    delete itemData._stashId;

    const created = await app.actor.createEmbeddedDocuments("Item", [itemData]);
    if (!created.length) return;

    const groupActor = game.actors.get(data.groupActorId);
    if (!groupActor) return;

    const stash = _getStash(groupActor);
    if (data.stashIndex >= 0 && data.stashIndex < stash.length) {
      stash.splice(data.stashIndex, 1);
      const gSheet = groupActor.sheet;
      if (gSheet) gSheet._stashActiveTab = "stash";
      await _setStash(groupActor, stash);
    }
    ui.notifications.info(`${itemData.name} moved to ${app.actor.name}.`);
  }, true); // capture phase
}

/* ─── Ready ─── */

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready. FVTT ${game.version}, Crucible ${game.system?.version}`);
});