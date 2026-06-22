const MODULE_ID = "crucible-party-stash";
const TEMPLATE_STASH = `modules/${MODULE_ID}/templates/stash-panel.hbs`;

/* ─── Stash Mutex ───
 * Per-actor serialized lock to prevent races from concurrent setFlag calls
 * (double-click, overlapping async operations, multiple group sheets).
 */
const _stashLocks = new Map();

function _withStashLock(actorId, fn) {
  if (!_stashLocks.has(actorId)) {
    _stashLocks.set(actorId, Promise.resolve());
  }
  // The chain stored in the map must always settle so the next
  // queued operation always executes. We use a separate resolver to
  // decouple the callers's result from the serialization chain.
  let resolve;
  const sentinel = new Promise(r => resolve = r);
  const result = _stashLocks.get(actorId).then(fn).finally(() => resolve());
  _stashLocks.set(actorId, sentinel);
  return result.catch(err => {
    console.error(`${MODULE_ID} | Stash lock error for actor ${actorId}:`, err);
    throw err;
  });
}

/* ─── Utilities ─── */

function _readStash(groupActor) {
  return groupActor.getFlag(MODULE_ID, "stash") ?? [];
}

function _getStash(groupActor) {
  return foundry.utils.deepClone(_readStash(groupActor));
}

async function _setStash(groupActor, stash) {
  await groupActor.setFlag(MODULE_ID, "stash", stash);
}

function _checkStashCapacity(stash) {
  const max = game.settings.get(MODULE_ID, "stashCapacity");
  return { ok: max === 0 || stash.length < max, max };
}

/**
 * Whether a plain item-data object represents a stackable physical item.
 * Works on both live Item documents and serialised stash entries.
 * Mirrors CrucibleItem#isStackable eligibility logic.
 * @param {object} itemData  item.toObject() or a stash entry
 * @returns {boolean}
 */
function _isStackable(itemData) {
  const props = itemData.system?.properties;
  if (!props) return false;
  // properties may be a Set (live document) or an Array (serialised)
  const hasStackable = props instanceof Set
    ? props.has("stackable")
    : Array.isArray(props) && props.includes("stackable");
  if (!hasStackable) return false;
  // Items with ActiveEffects (affixes, enchantments) are never stackable
  if (itemData.effects?.length) return false;
  return true;
}

/**
 * Strip Crucible's stacked-item name prefix, e.g. "(2) Alchemist's Fire" → "Alchemist's Fire".
 * @param {string} name
 * @returns {string}
 */
function _baseItemName(name) {
  return (name ?? "").replace(/^\(\d+\)\s*/, "");
}

/**
 * Compare two stash entries for merge eligibility.
 * Both must be stackable and share the same base name (stripped of quantity prefix).
 */
function _stashEntryMatches(a, b) {
  if (!_isStackable(a) || !_isStackable(b)) return false;
  return _baseItemName(a.name) === _baseItemName(b.name);
}

/**
 * Prompt the user for a quantity between 1 and max inclusive.
 * @param {string} label - i18n key for the field label
 * @param {number} max
 * @param {string} title - dialog window title
 * @param {number} [initial=1]
 * @returns {Promise<number|null>}
 */
async function _promptQuantity(label, max, title, initial = 1) {
  if (max <= 1) return 1;

  // Unique ID per dialog instance to find the input regardless of DOM structure
  const qtyId = `stash-qty-${foundry.utils.randomID()}`;
  const contentHTML = `<div class="stash-dialog-content">
    <div class="form-group">
      <label>${label}</label>
      <div class="form-fields">
        <input id="${qtyId}" type="number" name="quantity" min="1" max="${max}" value="${Math.clamp(initial, 1, max)}" autofocus>
      </div>
    </div>
  </div>`;

  try {
    const qty = await foundry.applications.api.DialogV2.prompt({
      window: { title, icon: "fa-solid fa-cubes" },
      content: contentHTML,
      ok: {
        label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Give"),
        icon: "fa-solid fa-check",
        callback: (event, button) => {
          const input = document.getElementById(qtyId);
          const val = input ? Number(input.value) : null;
          console.log(`${MODULE_ID} | [_promptQuantity] id=${qtyId}, input=${!!input}, val=${val}, max=${max}`);
          if (!val || val < 1 || val > max) return null;
          return val;
        }
      },
      rejectClose: false
    });
    return typeof qty === "number" ? qty : null;
  } catch (err) {
    console.error(`${MODULE_ID} | _promptQuantity error:`, err);
    return null;
  }
}

/**
 * Whether the current user meets the minimum role to see and use the stash.
 * GMs always pass.
 * @returns {boolean}
 */
function canUseStash() {
  if (game.user.isGM) return true;
  const minRole = game.settings.get(MODULE_ID, "minRole");
  return game.user.role >= minRole;
}

/* ─── Initialization ─── */

Hooks.once("init", async () => {
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

  game.settings.register(MODULE_ID, "minRole", {
    name: "CRUCIBLE_PARTY_STASH.MinRole",
    hint: "CRUCIBLE_PARTY_STASH.MinRoleHint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.NumberField({
      initial: CONST.USER_ROLES.PLAYER,
      choices: {
        [CONST.USER_ROLES.PLAYER]: "USER.RolePlayer",
        [CONST.USER_ROLES.TRUSTED]: "USER.RoleTrusted",
        [CONST.USER_ROLES.ASSISTANT]: "USER.RoleAssistant",
        [CONST.USER_ROLES.GAMEMASTER]: "USER.RoleGamemaster"
      }
    })
  });

  await foundry.applications.handlebars.loadTemplates([TEMPLATE_STASH]);
});

/* ─── Render the stash panel HTML ─── */

async function _renderStashHTML(items, isEditable) {
  try {
    return await foundry.applications.handlebars.renderTemplate(
      TEMPLATE_STASH,
      { items, isEmpty: items.length === 0, isEditable }
    );
  } catch (err) {
    console.error(`${MODULE_ID} | Template render failed`, err);
    return `<div class="stash-empty">
      <p><i class="fa-solid fa-exclamation-triangle"></i> ${game.i18n.localize("CRUCIBLE_PARTY_STASH.TemplateError")}</p>
    </div>`;
  }
}

/* ─── Core Injection ───
 *
 * CrucibleGroupActorSheet uses root: true on its single PARTS entry, so Foundry
 * places children directly inside .window-content rather than a .sheet-body wrapper.
 * We target .window-content accordingly. */

Hooks.on("renderCrucibleGroupActorSheet", async (app, element, context, options) => {
  const actor = app.actor;
  if (!actor || actor.type !== "group") return;

  // ── permission gate ──
  if (!canUseStash()) return;

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

  // Capture original sheet children into the members panel
  const originalChildren = Array.from(windowContent.childNodes);

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

    console.log(`${MODULE_ID} | [drop] Drop data received`, { name: data.data?.name, type: data.type });

    const item = await Item.implementation.fromDropData(data);
    if (!item) { console.log(`${MODULE_ID} | [drop] fromDropData returned null`); return; }
    console.log(`${MODULE_ID} | [drop] Item resolved`, { name: item.name, id: item.id, parent: item.parent?.name, qty: item.system?.quantity });

    // Early capacity check (optimization — avoids dialog if full and no merge possible)
    const currentStash = _readStash(groupActor);
    const incomingData = item.toObject();
    console.log(`${MODULE_ID} | [drop] Stash size ${currentStash.length}, capacity check`, _checkStashCapacity(currentStash));
    if (!_checkStashCapacity(currentStash).ok && !currentStash.some(e => _stashEntryMatches(e, incomingData))) {
      ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: game.settings.get(MODULE_ID, "stashCapacity") }));
      return;
    }

    const src = item.parent;
    const srcItemQty = foundry.utils.getProperty(item, "system.quantity") ?? 1;
    const srcStackable = _isStackable(incomingData);
    console.log(`${MODULE_ID} | [drop] Source`, { actor: src?.name, id: src?.id, qty: srcItemQty, stackable: srcStackable, props: incomingData.system?.properties, effects: incomingData.effects?.length });

    // ── Quantity / confirm outside lock ──
    let chosenQty = 1;
    if (src instanceof Actor && src.id !== groupActor.id) {
      if (srcStackable && srcItemQty > 1) {
        // Always prompt for quantity for stacks — replaces the old confirm dialog
        chosenQty = await _promptQuantity(
          game.i18n.localize("CRUCIBLE_PARTY_STASH.StashQuantity"),
          srcItemQty,
          game.i18n.localize("CRUCIBLE_PARTY_STASH.MoveToStash"),
          1
        );
        if (!chosenQty) return;
      } else if (game.settings.get(MODULE_ID, "confirmTransfer")) {
        console.log(`${MODULE_ID} | [drop] Single item, confirmTransfer ON`);
        // Single item: gate on confirmTransfer as before, no Copy Only
        try {
          const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize("CRUCIBLE_PARTY_STASH.MoveToStash") },
            content: `<p>${game.i18n.format("CRUCIBLE_PARTY_STASH.MoveConfirm", { name: item.name, actor: src.name })}</p>`,
            yes: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Move"), icon: "fa-solid fa-box-open" },
            no: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Cancel"), icon: "fa-solid fa-ban" }
          });
          if (!confirmed) return;
        } catch { return; }
      } else {
        console.log(`${MODULE_ID} | [drop] Single item, confirmTransfer OFF — auto-move`);
      }
    } else {
      console.log(`${MODULE_ID} | [drop] No source actor (compendium?) or same as group — copy only`);
    }

    console.log(`${MODULE_ID} | [drop] Chosen quantity: ${chosenQty}, entering lock`);

      // ── Stash mutation under lock ──
    const result = await _withStashLock(groupActor.id, async () => {
      console.log(`${MODULE_ID} | [drop] Inside lock, re-validating source`);
      // Re-validate source — it may have changed while dialogs were open
      const currentSrc = src instanceof Actor ? game.actors.get(src.id) : null;
      if (currentSrc) {
        const currentItem = currentSrc.items.get(item.id);
        if (!currentItem) {
          console.log(`${MODULE_ID} | [drop] Source validation FAILED — item ${item.id} no longer exists on ${currentSrc.name}`);
          ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.SourceChanged"));
          return null;
        }
        const currentQty = foundry.utils.getProperty(currentItem, "system.quantity") ?? 1;
        if (currentQty < chosenQty) {
          console.log(`${MODULE_ID} | [drop] Source validation FAILED — qty ${currentQty} < chosen ${chosenQty}`);
          ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.InsufficientQuantity", { available: currentQty }));
          return null;
        }
        console.log(`${MODULE_ID} | [drop] Source validated: ${currentItem.name} qty=${currentQty}`);
      } else {
        console.log(`${MODULE_ID} | [drop] No source actor to validate — compendium drop`);
      }

      const s = _getStash(groupActor);
      const itemData = foundry.utils.deepClone(incomingData);

      // Only attempt merge if the incoming item is stackable
      const canMerge = _isStackable(itemData);
      console.log(`${MODULE_ID} | [drop] Merge check: isStackable=${canMerge}, stashEntries=${s.length}`);
      const mergeIdx = canMerge
        ? s.findIndex(e => {
            const match = _stashEntryMatches(e, itemData);
            console.log(`${MODULE_ID} | [drop]   ~ "${_baseItemName(e.name)}" vs "${_baseItemName(itemData.name)}": ${match ? "MATCH" : "no match"}`);
            return match;
          })
        : -1;
      if (mergeIdx !== -1) {
        console.log(`${MODULE_ID} | [drop] Merging with entry ${mergeIdx}, current qty=${s[mergeIdx].system.quantity ?? 1}, adding ${chosenQty}`);
        s[mergeIdx].system.quantity = (s[mergeIdx].system.quantity ?? 1) + chosenQty;
        const sheet = groupActor.sheet;
        if (sheet) sheet._stashActiveTab = "stash";
        await _setStash(groupActor, s);
        return { name: item.name, merged: true, totalQty: s[mergeIdx].system.quantity };
      }

      // No merge — check capacity
      const cap = _checkStashCapacity(s);
      if (!cap.ok) {
        console.log(`${MODULE_ID} | [drop] Capacity full (${s.length}/${cap.max}), cannot push`);
        ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: cap.max }));
        return null;
      }

      console.log(`${MODULE_ID} | [drop] Pushing new entry, qty=${chosenQty}`);
      itemData._stashId = foundry.utils.randomID();
      itemData.system.quantity = chosenQty;
      s.push(itemData);
      const sheet = groupActor.sheet;
      if (sheet) sheet._stashActiveTab = "stash";
      await _setStash(groupActor, s);
      console.log(`${MODULE_ID} | [drop] Stash written, new entry ${itemData._stashId?.slice(0,8)}, stash size now ${s.length}`);
      return { name: item.name, merged: false };
    });

    if (!result) { console.log(`${MODULE_ID} | [drop] Lock returned null — aborting`); return; }
    console.log(`${MODULE_ID} | [drop] Lock succeeded`, result);

    // ── Source-side mutation: only after stash write succeeds ──
    if (src instanceof Actor && src.id !== groupActor.id) {
      if (chosenQty < srcItemQty) {
        console.log(`${MODULE_ID} | [drop] Reducing source qty from ${srcItemQty} to ${srcItemQty - chosenQty}`);
        await src.updateEmbeddedDocuments("Item", [{ _id: item.id, "system.quantity": srcItemQty - chosenQty }]);
      } else {
        console.log(`${MODULE_ID} | [drop] Deleting source item ${item.id} from ${src.name}`);
        await src.deleteEmbeddedDocuments("Item", [item.id]);
      }
    }

    if (result.merged) {
      ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.MergedWithStash", { name: result.name, quantity: result.totalQty }));
    } else {
      ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemAdded", { name: result.name }));
    }
  });
}

/* ─── Click: Give / Remove ───
 * Uses data-stash-action instead of data-action to prevent Foundry's
 * ApplicationV2 action system from intercepting clicks. */

function _activateStashActionListeners(stashTab, groupActor) {
  // Prevent draggable parent <li> from eating clicks on control buttons
  stashTab.addEventListener("mousedown", (ev) => {
    const control = ev.target.closest("[data-stash-action]");
    if (control) {
      ev.stopPropagation();
    }
  });

  stashTab.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-stash-action]");
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();

    const action = el.dataset.stashAction;
    const stashId = el.dataset.stashId;

    if (action === "remove") {
      const removed = await _withStashLock(groupActor.id, async () => {
        const s = _getStash(groupActor);
        const idx = s.findIndex(e => e._stashId === stashId);
        if (idx === -1) return null;
        const [item] = s.splice(idx, 1);
        const sheet = groupActor.sheet;
        if (sheet) sheet._stashActiveTab = "stash";
        await _setStash(groupActor, s);
        return item;
      });
      ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemRemoved", { name: removed?.name ?? "Unknown" }));
      return;
    }

    if (action === "give") {
      const memberArray = groupActor.system.members ?? [];

      // Crucible attaches an `actors` Set of resolved Actor instances on the members array
      const actors = memberArray.actors
        ? Array.from(memberArray.actors)
        : Array.from(memberArray).map(m => game.actors.get(m.actorId ?? m.id ?? m._id)).filter(Boolean);

      if (!actors.length) {
        ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoMembers"));
        return;
      }

      const choices = {};
      for (const actor of actors) choices[actor.id] = actor.name;
      const recipient = await _pickRecipient(choices);
      if (!recipient) return;

      const target = game.actors.get(recipient);
      if (!target) { ui.notifications.error(game.i18n.localize("CRUCIBLE_PARTY_STASH.RecipientNotFound")); return; }

      const name = await _initiateTransferToActor(groupActor, stashId, target);
      if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemGiven", { name, target: target.name }));
    }
  });

  // Drag items OUT of the stash
  stashTab.addEventListener("dragstart", (ev) => {
    // Don't let control buttons (give/remove) trigger a drag
    if (ev.target.closest("[data-stash-action]")) {
      ev.preventDefault();
      return;
    }
    const li = ev.target.closest(".stash-item[data-stash-id]");
    if (!li) return;
    const stashId = li.dataset.stashId;
    const stash = _readStash(groupActor);
    const itemData = stash.find(e => e._stashId === stashId);
    if (!itemData) return;
    ev.dataTransfer.setData("text/plain", JSON.stringify({
      type: "Item",
      data: itemData,
      fromStash: true,
      stashId,
      groupActorId: groupActor.id
    }));
  });
}

/* ─── Transfer: stash → character ───
 * @param {Actor} groupActor
 * @param {string} stashId
 * @param {Actor} targetActor
 * @param {number} [quantity] - optional quantity to take; omitted = full entry
 * @returns {Promise<string|null>} item name on success
 */

async function _transferFromStash(groupActor, stashId, targetActor, quantity) {
  return _withStashLock(groupActor.id, async () => {
    const stash = _getStash(groupActor);
    const entryIdx = stash.findIndex(e => e._stashId === stashId);
    if (entryIdx === -1) return null;
    const entry = stash[entryIdx];

    const entryQty = entry.system?.quantity ?? 1;
    const takeQty = (quantity !== undefined) ? Math.min(quantity, entryQty) : entryQty;
    if (takeQty <= 0) return null;

    const itemData = foundry.utils.deepClone(entry);
    delete itemData._stashId;
    if (!_isStackable(entry)) {
      itemData.system.quantity = 1; // Safety clamp: Crucible enforces qty ≤ 1 for non-stackable items
    } else {
      itemData.system.quantity = takeQty;
    }

    // If stackable, try to merge into an existing matching item on the target actor
    let created;
    if (_isStackable(entry)) {
      const existingItem = targetActor.items.find(i => _stashEntryMatches(i.toObject(), itemData));
      if (existingItem) {
        const existingQty = foundry.utils.getProperty(existingItem, "system.quantity") ?? 1;
        await existingItem.update({ "system.quantity": existingQty + takeQty });
        created = [existingItem];
      }
    }

    if (!created) {
      created = await targetActor.createEmbeddedDocuments("Item", [itemData]);
    }
    if (!created.length) return null;

    const remaining = entryQty - takeQty;
    if (remaining > 0) {
      entry.system.quantity = remaining;
    } else {
      stash.splice(entryIdx, 1);
    }
    const sheet = groupActor.sheet;
    if (sheet) sheet._stashActiveTab = "stash";
    await _setStash(groupActor, stash);

    return entry.name;
  });
}

/* ─── Initiate transfer with quantity prompt ───
 * Reads the stash entry, prompts for quantity if stackable,
 * then delegates to _transferFromStash. All user-facing dialogs
 * happen outside the lock.
 */

async function _initiateTransferToActor(groupActor, stashId, targetActor) {
  // Read outside lock for dialog — entry snapshot may be stale, validated inside lock
  const stash = _readStash(groupActor);
  const entry = stash.find(e => e._stashId === stashId);
  if (!entry) return null;

  const entryQty = entry.system?.quantity ?? 1;
  // Only prompt for quantity if the item is actually stackable
  const stackable = _isStackable(entry);
  let chosenQty = stackable ? entryQty : 1;
  if (stackable && entryQty > 1) {
    chosenQty = await _promptQuantity(
      game.i18n.localize("CRUCIBLE_PARTY_STASH.TakeQuantity"),
      entryQty,
      game.i18n.localize("CRUCIBLE_PARTY_STASH.GiveItem"),
      entryQty
    );
    if (!chosenQty) return null;
  }

  return _transferFromStash(groupActor, stashId, targetActor, chosenQty);
}

/* ─── Recipient picker dialog ─── */

async function _pickRecipient(choices) {
  const recipId = `stash-recip-${foundry.utils.randomID()}`;
  const contentHTML = `<div class="stash-dialog-content">
    <div class="form-group">
      <label>${game.i18n.localize("CRUCIBLE_PARTY_STASH.Recipient")}</label>
      <div class="form-fields">
        <select id="${recipId}" name="recipient">
          ${Object.entries(choices).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
        </select>
      </div>
    </div>
  </div>`;

  try {
    return await foundry.applications.api.DialogV2.prompt({
      window: {
        title: game.i18n.localize("CRUCIBLE_PARTY_STASH.GiveItem"),
        icon: "fa-solid fa-hand-holding"
      },
      content: contentHTML,
      ok: {
        label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Give"),
        icon: "fa-solid fa-check",
        callback: (event, button) => {
          const select = document.getElementById(recipId);
          console.log(`${MODULE_ID} | [_pickRecipient] id=${recipId}, select=${!!select}, val=${select?.value}`);
          return select?.value || null;
        }
      },
      rejectClose: false
    });
  } catch (err) {
    console.error(`${MODULE_ID} | _pickRecipient error:`, err);
    return null;
  }
}

/* ─── Stash → character (V1 dropActorSheetData hook) ─── */

Hooks.on("dropActorSheetData", async (targetActor, sheet, data) => {
  if (!data?.fromStash || data.groupActorId === targetActor.id) return;
  const groupActor = game.actors.get(data.groupActorId);
  if (!groupActor) return;

  const name = await _initiateTransferToActor(groupActor, data.stashId, targetActor);
  if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemMovedTo", { name, target: targetActor.name }));
});

/* ─── Stash → V2 hero sheet (direct drop interception) ─── */

function _setupHeroDropInterception(app, element) {
  if (element.dataset.stashDropReady) return;
  element.dataset.stashDropReady = "1";

  // Capturing-phase listener intercepts stash drops before the sheet's own handler.
  // It's unclear whether dropActorSheetData would fire reliably for stash drops
  // originating from plain DOM elements (non-ApplicationV2), so we intercept here
  // as a guarantee. If dropActorSheetData is confirmed to work in all cases, this
  // interception and its call sites can be removed in favor of that hook alone.

  element.addEventListener("drop", async (ev) => {
    let data;
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
    if (!data?.fromStash || data.groupActorId === app.actor?.id) return;

    ev.preventDefault();
    ev.stopPropagation();

    const groupActor = game.actors.get(data.groupActorId);
    if (!groupActor) return;

    const name = await _initiateTransferToActor(groupActor, data.stashId, app.actor);
    if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemMovedTo", { name, target: app.actor.name }));
  }, true);
}

/* ─── Ready ─── */

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready. FVTT ${game.version}, Crucible ${game.system?.version}`);
});