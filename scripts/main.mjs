const MODULE_ID = "crucible-party-stash";

/* ─── Utilities ─── */

/**
 * Get the party stash item array from the group actor's flags.
 * Returns a shallow clone so callers can mutate safely before saving.
 * @param {Actor} groupActor
 * @returns {object[]}
 */
function _getStash(groupActor) {
  return foundry.utils.deepClone(groupActor.getFlag(MODULE_ID, "stash") ?? []);
}

/**
 * Persist a mutated stash array to the group actor's flags.
 * Triggers a re-render of the group sheet automatically.
 * @param {Actor} groupActor
 * @param {object[]} stash
 */
async function _setStash(groupActor, stash) {
  await groupActor.setFlag(MODULE_ID, "stash", stash);
}

/**
 * Check whether the stash can accept more items.
 * @param {object[]} stash
 * @returns {{ok: boolean, max: number}}
 */
function _checkStashCapacity(stash) {
  const max = game.settings.get(MODULE_ID, "stashCapacity");
  return { ok: max === 0 || stash.length < max, max };
}

/* ─── Initialization ─── */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Party Stash module`);

  // Register module settings
  game.settings.register(MODULE_ID, "stashCapacity", {
    name: game.i18n.localize("CRUCIBLE_PARTY_STASH.StashCapacity"),
    hint: game.i18n.localize("CRUCIBLE_PARTY_STASH.StashCapacityHint"),
    scope: "world",
    config: true,
    type: Number,
    default: 0,
    range: { min: 0, max: 999 }
  });

  game.settings.register(MODULE_ID, "confirmTransfer", {
    name: game.i18n.localize("CRUCIBLE_PARTY_STASH.ConfirmTransfer"),
    hint: game.i18n.localize("CRUCIBLE_PARTY_STASH.ConfirmTransferHint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

/* ─── Template Preloading ─── */

Hooks.once("preloadTemplates", async () => {
  await loadTemplates([
    `modules/${MODULE_ID}/templates/stash-panel.hbs`
  ]);
});

/* ─── Inject Stash Tab into Group Sheet ─── */

Hooks.on("renderCrucibleGroupActorSheet", async (app, element, context, options) => {
  const actor = app.actor;
  if (actor.type !== "group") return;

  // Only inject once per sheet render cycle
  if (element.querySelector(".party-stash-tabs")) return;

  const isEditable = app.isEditable;
  const stashItems = _getStash(actor);

  // Locate the sheet body
  const sheetBody = element.querySelector(".sheet-body");
  if (!sheetBody) return;

  // ── Build tab bar ──
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

  // ── Wrap existing content in a Members tab ──
  const existingContent = sheetBody.innerHTML;
  sheetBody.innerHTML = "";
  sheetBody.prepend(tabBar);

  const membersTab = document.createElement("div");
  membersTab.className = "tab-content active";
  membersTab.dataset.tab = "members";
  membersTab.dataset.group = "stash-tabs";
  membersTab.innerHTML = existingContent;
  sheetBody.appendChild(membersTab);

  // ── Build the Stash tab content from Handlebars template ──
  const stashTab = document.createElement("div");
  stashTab.className = "tab-content";
  stashTab.dataset.tab = "stash";
  stashTab.dataset.group = "stash-tabs";
  stashTab.innerHTML = await renderTemplate("modules/crucible-party-stash/templates/stash-panel.hbs", {
    items: stashItems,
    isEmpty: stashItems.length === 0,
    isEditable
  });
  sheetBody.appendChild(stashTab);

  // ── Tab click handler ──
  tabBar.addEventListener("click", (ev) => {
    const tabLink = ev.target.closest(".tab-item");
    if (!tabLink) return;
    ev.preventDefault();

    const targetTab = tabLink.dataset.tab;
    if (!targetTab) return;

    // Update tab link states
    tabBar.querySelectorAll(".tab-item").forEach(t => {
      const active = t.dataset.tab === targetTab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    });

    // Update tab panel visibility
    sheetBody.querySelectorAll(".tab-content").forEach(c => {
      c.classList.toggle("active", c.dataset.tab === targetTab);
    });
  });

  // ── Enable drag-and-drop onto the stash tab ──
  _activateStashDropListeners(stashTab, actor);
  _activateStashActionListeners(stashTab, actor);
});

/* ─── Drop Handler: Accept items into the stash ─── */

function _activateStashDropListeners(stashTab, groupActor) {
  // Visual feedback on dragover
  stashTab.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    stashTab.classList.add("drag-over");
  });

  stashTab.addEventListener("dragleave", (ev) => {
    // Only remove highlight when actually leaving the stash tab
    if (!stashTab.contains(ev.relatedTarget)) {
      stashTab.classList.remove("drag-over");
    }
  });

  stashTab.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    stashTab.classList.remove("drag-over");

    let data;
    try {
      data = JSON.parse(ev.dataTransfer.getData("text/plain"));
    } catch {
      return;
    }

    // Accept Item drops only
    if (data.type !== "Item") return;

    // Reject drops from another stash (already handled by hook, but safety)
    if (data.fromStash) return;

    // Resolve the item — works for world items, compendium items, and owned items
    const item = await Item.implementation.fromDropData(data);
    if (!item) return;

    const itemData = item.toObject();

    // Check stash capacity before proceeding
    const currentStash = _getStash(groupActor);
    const capacity = _checkStashCapacity(currentStash);
    if (!capacity.ok) {
      ui.notifications.warn(
        game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: capacity.max })
      );
      return;
    }

    // If item comes from a different actor, optionally delete from source
    const sourceActor = item.parent;
    let shouldDelete = false;

    if (sourceActor instanceof Actor && sourceActor.id !== groupActor.id) {
      if (game.settings.get(MODULE_ID, "confirmTransfer")) {
        try {
          shouldDelete = await foundry.applications.api.DialogV2.confirm({
            window: {
              title: game.i18n.localize("CRUCIBLE_PARTY_STASH.MoveToStash"),
              icon: "fa-solid fa-box-open"
            },
            content: game.i18n.format("CRUCIBLE_PARTY_STASH.MoveConfirm", {
              name: item.name,
              actor: sourceActor.name
            }),
            modal: true,
            rejectClose: false,
            yes: {
              label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Move"),
              icon: "fa-solid fa-box-open",
              callback: () => true
            },
            no: {
              label: game.i18n.localize("CRUCIBLE_PARTY_STASH.CopyOnly"),
              icon: "fa-solid fa-copy",
              callback: () => false
            }
          });
        } catch {
          // Dialog dismissed — cancel entirely
          return;
        }
      } else {
        shouldDelete = true; // Default to move when confirmations are disabled
      }

      if (shouldDelete) {
        // Ensure we have the latest source actor data
        const src = game.actors.get(sourceActor.id);
        if (src) {
          await src.deleteEmbeddedDocuments("Item", [item.id]);
        }
      }
    }

    // Add to stash
    itemData._stashId = foundry.utils.randomID();
    currentStash.push(itemData);
    await _setStash(groupActor, currentStash);

    ui.notifications.info(`${item.name} added to party stash.`);
  });
}

/* ─── Click Handlers: Give / Remove ─── */

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
      // Build a selection of party members
      const members = groupActor.system.members ?? [];

      // Filter to only members with resolved actor references
      const validMembers = members.filter(m => m.actor instanceof Actor);
      if (validMembers.length === 0) {
        ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoMembers"));
        return;
      }

      // Create a form to pick the recipient
      const choices = {};
      for (const m of validMembers) {
        choices[m.actorId] = m.actor.name;
      }

      // Use a FormApplication-style dialog for the recipient picker
      const recipient = await _pickRecipient(choices);
      if (!recipient) return;

      const targetActor = game.actors.get(recipient);
      if (!targetActor) {
        ui.notifications.error(`Recipient actor not found.`);
        return;
      }

      const itemData = stash[index];
      if (!itemData) return;

      // Create the item on the target actor
      const createData = foundry.utils.deepClone(itemData);
      delete createData._id;
      delete createData._stashId;
      delete createData.flags?.[MODULE_ID];

      await targetActor.createEmbeddedDocuments("Item", [createData]);

      // Remove from stash
      stash.splice(index, 1);
      await _setStash(groupActor, stash);

      ui.notifications.info(`${itemData.name} given to ${targetActor.name}.`);
      return;
    }
  });

  // ── Drag items OUT of the stash ──
  stashTab.addEventListener("dragstart", (ev) => {
    const li = ev.target.closest(".stash-item[data-index]");
    if (!li) return;

    const index = Number(li.dataset.index);
    const stash = _getStash(groupActor);
    const itemData = stash[index];
    if (!itemData) return;

    // Serialize the drag data so dropActorSheetData can intercept it
    const dragData = {
      type: "Item",
      data: itemData,
      fromStash: true,
      stashIndex: index,
      groupActorId: groupActor.id
    };

    ev.dataTransfer.setData("text/plain", JSON.stringify(dragData));
    ev.dataTransfer.dropEffect = "move";
  });
}

/**
 * Show a simple dialog to pick a recipient actor from a list of choices.
 * @param {Record<string, string>} choices — map of actorId → name
 * @returns {Promise<string|null>} selected actorId or null
 */
async function _pickRecipient(choices) {
  const field = new foundry.data.fields.StringField({
    label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Recipient"),
    choices,
    required: true,
    blank: false
  });

  const content = document.createElement("div");
  content.style.cssText = "padding: 0.5rem;";
  content.append(field.toFormGroup({}, { name: "recipient" }));

  try {
    const result = await foundry.applications.api.DialogV2.prompt({
      window: {
        title: game.i18n.localize("CRUCIBLE_PARTY_STASH.GiveItem"),
        icon: "fa-solid fa-hand-holding"
      },
      content,
      ok: {
        label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Give"),
        icon: "fa-solid fa-check",
        callback: (event, button, formData) => {
          const fd = new FormData(button.form || formData);
          return fd.get("recipient") || null;
        }
      },
      rejectClose: false
    });
    return result;
  } catch {
    return null;
  }
}

/* ─── Handle receiving stash items on character sheets ─── */

Hooks.on("dropActorSheetData", async (targetActor, sheet, data) => {
  if (!data?.fromStash) return;

  // Ensure we're not dropping onto the group sheet itself
  if (data.groupActorId === targetActor.id) return;

  const itemData = foundry.utils.deepClone(data.data);
  delete itemData._id;
  delete itemData._stashId;
  delete itemData.flags?.[MODULE_ID];

  // Create on target
  const created = await targetActor.createEmbeddedDocuments("Item", [itemData]);
  if (!created.length) return;

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