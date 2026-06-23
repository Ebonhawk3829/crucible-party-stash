const MODULE_ID = "crucible-party-stash";
const TEMPLATE_STASH = `modules/${MODULE_ID}/templates/stash-panel.hbs`;

/* ─── Stash Mutex ───
 * Per-actor serialized lock to prevent races from concurrent setFlag calls
 * (double-click, overlapping async operations, multiple group sheets).
 */
const _stashLocks = new Map();

/* Prevent double-fire when both the capturing drop listener and
 * dropActorSheetData hook process the same stash→hero drag. */
const _handledStashDrops = new Set();

function _withStashLock(actorId, fn) {
  if (!_stashLocks.has(actorId)) {
    _stashLocks.set(actorId, Promise.resolve());
  }
  // The chain must always settle so queued operations execute in order.
  let resolve;
  const sentinel = new Promise(r => resolve = r);
  const result = _stashLocks.get(actorId).then(fn).finally(() => resolve());
  _stashLocks.set(actorId, sentinel);
  return result.catch(err => {
    console.error(`${MODULE_ID} | Stash lock error for actor ${actorId}:`, err);
    throw err;
  });
}

function _readStash(groupActor) {
  const raw = groupActor.getFlag(MODULE_ID, "stash") ?? [];
  if (!Array.isArray(raw)) {
    console.warn(`${MODULE_ID} | Stash flag is not an array — resetting`);
    return [];
  }
  return raw.filter(entry => {
    if (!entry || typeof entry !== "object" || !entry.name || !entry.type || !entry._stashId) {
      console.warn(`${MODULE_ID} | Filtering malformed stash entry:`, entry);
      return false;
    }
    return true;
  });
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

/* ─── Stash Tooltips ───
 *
 * On hover, builds a temporary in-memory CrucibleItem from the serialised
 * stash data and calls renderCard(). Uses game.tooltip.activate() directly
 * to avoid synthetic event re-dispatch and data-tooltip-html attribute races.
 *
 * Fallback: if renderCard() fails (e.g. item type that requires actor context),
 * shows the item name + icon instead of nothing.
 */

const _TOOLTIP_CACHE_MAX = 50;

const _stashTooltip = {
  _activeId: null,
  _deactivateTimeout: null,
  _cache: new Map(),

  /**
   * Bind tooltip listeners directly to each <li> element.
   * Called once per render from the renderCrucibleGroupActorSheet hook.
   * @param {HTMLElement} stashTab
   * @param {Actor} groupActor
   */
  bind(stashTab, groupActor) {
    const items = stashTab.querySelectorAll(".stash-item[data-stash-id]");
    for (const li of items) {
      li.addEventListener("pointerenter", (ev) => this._onItemEnter(ev, li, groupActor));
      li.addEventListener("pointerleave", (ev) => this._onItemLeave(ev, li));
    }
  },

  _onItemEnter(ev, li, groupActor) {
    const stashId = li.dataset.stashId;

    if (this._activeId === stashId) {
      clearTimeout(this._deactivateTimeout);
      this._deactivateTimeout = null;
      // Recover if the tooltip was killed by tab switch or external action.
      if (!document.getElementById("tooltip")?.classList.contains("active")) {
        this._showTooltip(li, stashId, groupActor);
      }
      return;
    }

    if (this._activeId) {
      clearTimeout(this._deactivateTimeout);
      this._deactivateTimeout = null;
      game.tooltip.deactivate();
    }

    this._activeId = stashId;
    this._showTooltip(li, stashId, groupActor);
  },

  _onItemLeave(ev, li) {
    if (this._activeId !== li.dataset.stashId) return;

    // Only deactivate on genuine <li> exit, not child-to-child moves.
    if (li.contains(ev.relatedTarget)) return;

    clearTimeout(this._deactivateTimeout);
    this._deactivateTimeout = setTimeout(() => {
      if (this._activeId === li.dataset.stashId) {
        this._activeId = null;
        game.tooltip.deactivate();
      }
      this._deactivateTimeout = null;
    }, 30);
  },

  async _showTooltip(li, stashId, groupActor) {
    const entry = _readStash(groupActor).find(e => e._stashId === stashId);
    if (!entry) return;

    const itemName = entry.name;
    const itemImg = entry.img;

    // undefined = miss, null = known fallback, Node = cached card.
    const cached = this._cache.get(stashId);
    if (cached !== undefined) {
      if (this._activeId !== stashId) return;
      if (!li.matches(":hover")) return;
      if (cached === null) {
        this._activateFallback(li, itemName, itemImg);
      } else {
        game.tooltip.activate(li, {
          html: cached.cloneNode(true),
          cssClass: "crucible crucible-tooltip"
        });
      }
      return;
    }

    const itemData = foundry.utils.deepClone(entry);
    delete itemData._stashId;

    let tempItem;
    try {
      tempItem = new Item.implementation(itemData);
    } catch (err) {
      console.debug(`${MODULE_ID} | Item construction failed, showing fallback tooltip`, err);
      if (this._activeId !== stashId) return;
      if (!li.matches(":hover")) return;
      this._cache.set(stashId, null);
      this._activateFallback(li, itemName, itemImg);
      return;
    }

    let html;
    try {
      if (typeof tempItem.renderCard !== "function") return;
      html = await tempItem.renderCard();
    } catch (err) {
      console.debug(`${MODULE_ID} | renderCard failed, showing fallback tooltip`, err);
    }

    if (this._activeId !== stashId) return;
    if (!li.matches(":hover")) return;

    if (!html) {
      this._cache.set(stashId, null);
      this._activateFallback(li, itemName, itemImg);
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;

    // Cache invalidated on re-render via clearCache().
    this._cache.set(stashId, wrapper);

    // Evict oldest if over ceiling (Map preserves insertion order).
    if (this._cache.size > _TOOLTIP_CACHE_MAX) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }

    game.tooltip.activate(li, {
      html: wrapper.cloneNode(true),
      cssClass: "crucible crucible-tooltip"
    });
  },

  /** Call when the stash tab is rebuilt to drop stale cached content. */
  clearCache() {
    this._cache.clear();
  },

  _activateFallback(li, name, img) {
    const wrapper = document.createElement("div");
    wrapper.className = "stash-tooltip-fallback";

    if (img) {
      const imgEl = document.createElement("img");
      imgEl.src = img;
      imgEl.width = 36;
      imgEl.height = 36;
      imgEl.alt = "";
      wrapper.appendChild(imgEl);
    }

    const strong = document.createElement("strong");
    strong.textContent = name ?? "Unknown";
    wrapper.appendChild(strong);

    game.tooltip.activate(li, {
      html: wrapper,
      cssClass: "crucible crucible-tooltip"
    });
  }
};

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
  const localized = items.map(item => ({
    ...item,
    typeLabel: CONFIG.Item.typeLabels?.[item.type]
      ? game.i18n.localize(CONFIG.Item.typeLabels[item.type])
      : item.type
  }));
  try {
    return await foundry.applications.handlebars.renderTemplate(
      TEMPLATE_STASH,
      { items: localized, isEmpty: items.length === 0, isEditable }
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
 * We target .window-content accordingly.
 *
 * Why full rebuild instead of in-place update:
 * - First render: no .party-stash-tabs exists → full injection needed.
 * - Re-render after Crucible replaces .window-content innerHTML wholesale
 *   (which it does on full re-renders): our structure is gone → full rebuild.
 * - Light re-render where DOM is intact: could theoretically update in-place,
 *   but there's no reliable way to detect "my structure is still intact" without
 *   doing essentially the same amount of work as rebuilding. */

Hooks.on("renderCrucibleGroupActorSheet", async (app, element, context, options) => {
  const actor = app.actor;
  if (!actor || actor.type !== "group") return;

  if (!canUseStash()) return;

  // Stash entries are immutable between flag writes, and any flag write
  // triggers a re-render. Clear the tooltip cache so stale rendered cards
  // from a previous render cycle are never served.
  _stashTooltip.clearCache();

  const windowContent = element.querySelector(".window-content");
  if (!windowContent) return;

  const isEditable = app.isEditable;
  const stashItems = _getStash(actor);
  const activeTab = app._stashActiveTab || "members";

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

  const originalChildren = Array.from(windowContent.childNodes);

  const membersTab = document.createElement("div");
  membersTab.className = `party-stash-panel ${activeTab === "members" ? "active" : ""}`;
  membersTab.dataset.stashTab = "members";
  for (const child of originalChildren) {
    membersTab.appendChild(child);
  }

  const stashTab = document.createElement("div");
  stashTab.className = `party-stash-panel ${activeTab === "stash" ? "active" : ""}`;
  stashTab.dataset.stashTab = "stash";
  stashTab.innerHTML = await _renderStashHTML(stashItems, isEditable);

  windowContent.innerHTML = "";
  windowContent.appendChild(tabBar);
  windowContent.appendChild(membersTab);
  windowContent.appendChild(stashTab);

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

  _activateStashDropListeners(stashTab, actor);
  _activateStashActionListeners(stashTab, actor);

  _stashTooltip.bind(stashTab, actor);
});

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

    // Early capacity check — avoids dialog if full and no merge possible
    const currentStash = _readStash(groupActor);
    const incomingData = item.toObject();
    if (!_checkStashCapacity(currentStash).ok && !currentStash.some(e => _stashEntryMatches(e, incomingData))) {
      ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: game.settings.get(MODULE_ID, "stashCapacity") }));
      return;
    }

    const src = item.parent;
    const srcItemQty = foundry.utils.getProperty(item, "system.quantity") ?? 1;
    const srcStackable = _isStackable(incomingData);

    // ── Quantity / confirm outside lock ──
    let chosenQty = 1;
    if (src instanceof Actor && src.id !== groupActor.id) {
      if (srcStackable && srcItemQty > 1) {
        chosenQty = await _promptQuantity(
          game.i18n.localize("CRUCIBLE_PARTY_STASH.StashQuantity"),
          srcItemQty,
          game.i18n.localize("CRUCIBLE_PARTY_STASH.MoveToStash"),
          1
        );
        if (!chosenQty) return;
      } else if (game.settings.get(MODULE_ID, "confirmTransfer")) {
        try {
          const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize("CRUCIBLE_PARTY_STASH.MoveToStash") },
            content: `<p>${game.i18n.format("CRUCIBLE_PARTY_STASH.MoveConfirm", { name: item.name, actor: src.name })}</p>`,
            yes: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Move"), icon: "fa-solid fa-box-open" },
            no: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Cancel"), icon: "fa-solid fa-ban" }
          });
          if (!confirmed) return;
        } catch { return; }
      }
    }

    // ── Stash mutation under lock ──
    const result = await _withStashLock(groupActor.id, async () => {
      // Re-validate source — it may have changed while dialogs were open
      const currentSrc = src instanceof Actor ? game.actors.get(src.id) : null;
      if (currentSrc) {
        const currentItem = currentSrc.items.get(item.id);
        if (!currentItem) {
          ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.SourceChanged"));
          return null;
        }
        const currentQty = foundry.utils.getProperty(currentItem, "system.quantity") ?? 1;
        if (currentQty < chosenQty) {
          ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.InsufficientQuantity", { available: currentQty }));
          return null;
        }
      }

      const s = _getStash(groupActor);
      const itemData = foundry.utils.deepClone(incomingData);

      const mergeIdx = _isStackable(itemData)
        ? s.findIndex(e => _stashEntryMatches(e, itemData))
        : -1;
      if (mergeIdx !== -1) {
        s[mergeIdx].system.quantity = (s[mergeIdx].system.quantity ?? 1) + chosenQty;
        const sheet = groupActor.sheet;
        if (sheet) sheet._stashActiveTab = "stash";
        await _setStash(groupActor, s);
        return { name: item.name, merged: true, totalQty: s[mergeIdx].system.quantity };
      }

      const cap = _checkStashCapacity(s);
      if (!cap.ok) {
        ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: cap.max }));
        return null;
      }

      itemData._stashId = foundry.utils.randomID();
      itemData.system.quantity = chosenQty;
      s.push(itemData);
      const sheet = groupActor.sheet;
      if (sheet) sheet._stashActiveTab = "stash";
      await _setStash(groupActor, s);
      return { name: item.name, merged: false };
    });

    if (!result) return;

    // ── Source-side mutation: only after stash write succeeds ──
    if (src instanceof Actor && src.id !== groupActor.id) {
      try {
        if (chosenQty < srcItemQty) {
          await src.updateEmbeddedDocuments("Item", [{ _id: item.id, "system.quantity": srcItemQty - chosenQty }]);
        } else {
          await src.deleteEmbeddedDocuments("Item", [item.id]);
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Failed to remove item from source after stash write`, err);
        ui.notifications.error(game.i18n.format("CRUCIBLE_PARTY_STASH.SourceRemovalFailed", { name: item.name }));
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
      if (!removed) return;
      ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemRemoved", { name: removed.name }));
      return;
    }

    if (action === "give") {
      const memberArray = groupActor.system.members ?? [];

      // Crucible's group member schema uses `actorId` as the reference field;
      // `memberArray.actors` is a runtime Set of resolved Actor instances.
      const actors = memberArray.actors
        ? Array.from(memberArray.actors)
        : Array.from(memberArray).map(m => game.actors.get(m.actorId ?? m.id)).filter(Boolean);

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

  stashTab.addEventListener("dragstart", (ev) => {
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
  if (_handledStashDrops.has(data.stashId)) return;
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

    // Prevent dropActorSheetData from also processing this drop.
    try {
      _handledStashDrops.add(data.stashId);
      const groupActor = game.actors.get(data.groupActorId);
      if (!groupActor) return;
      const name = await _initiateTransferToActor(groupActor, data.stashId, app.actor);
      if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemMovedTo", { name, target: app.actor.name }));
    } finally {
      _handledStashDrops.delete(data.stashId);
    }
  }, true);
}

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready. FVTT ${game.version}, Crucible ${game.system?.version}`);
});