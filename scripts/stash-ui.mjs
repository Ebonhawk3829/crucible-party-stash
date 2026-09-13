/* ─── Stash UI ───────────────────────────────────────────────────
 * DOM construction, event wiring, and tab injection for the
 * CrucibleGroupActorSheet. This is the only module that touches
 * the DOM for the group sheet.
 *
 * Imported by the entry point (main.mjs) for hook registration.
 * ──────────────────────────────────────────────────────────────── */

import {
  MODULE_ID,
  _readStash, _getStash, _setStash, _checkStashCapacity,
  _isStackable, _stashEntryMatches, _withStashLock,
  _getCurrency, _formatCurrency, _isShapedCurrency, _resolveGroupMembers, _log
} from "./stash-data.mjs";
import {
  _promptQuantity, _pickRecipient, _initiateTransferToActor,
  _takeCurrency, _splitCurrency, _depositCurrency, _createCurrency, _exchangeCurrency
} from "./stash-transfer.mjs";

export const TEMPLATE_STASH = `modules/${MODULE_ID}/templates/stash-panel.hbs`;

/* ─── Item type grouping ───
 * The item type is shown once as a group heading rather than as a tag on
 * every card. Only types that count as *inventory* produce a heading —
 * see _isInventoryType below.
 *
 * Order: the first five are Crucible's own verified sort order from
 * BaseActorSheet#preparePhysicalItem:
 *   {weapon: 1, armor: 2, accessory: 3, tool: 4, consumable: 5}
 * Then the physical-but-non-equippable types, then Foundry's "base"
 * fallback. Crucible defines no order for those three, so their placement
 * here is our convention, not the system's.
 *
 * Note: "treasure" is NOT an item type — it is a loot *category*
 * (SYSTEM.ITEM.LOOT_CATEGORIES: treasure / ingredient / other).
 */
const TYPE_GROUP_ORDER = [
  "weapon", "armor", "accessory", "tool", "consumable",
  "loot", "schematic",
  "base"
];

/** Foundry's fallback Item type; Crucible routes it to the backpack section. */
const BASE_TYPE = "base";

/**
 * Whether an item type belongs on an actor's Inventory tab — i.e. whether
 * it is a physical object rather than a character option.
 *
 * Crucible's own rule (BaseActorSheet#prepareItems) is:
 *   category = PHYSICAL_ITEM_TYPES.has(type) ? "physical" : type
 * with "physical" and "base" both landing in the inventory sections, while
 * talent / spell / ancestry / archetype / background / taxonomy go to their
 * own tabs. We mirror that exactly.
 *
 * @param {string} type
 * @returns {boolean}
 */
function _isInventoryType(type) {
  const physical = SYSTEM?.ITEM?.PHYSICAL_ITEM_TYPES;
  if (physical instanceof Set) return physical.has(type) || (type === BASE_TYPE);
  // Constant unavailable (system version drift) — fall back to the
  // hardcoded list so grouping still works rather than emptying the panel.
  return TYPE_GROUP_ORDER.includes(type);
}

/**
 * Bucket stash entries by item type, in a stable display order.
 * Only types with at least one entry produce a group. Non-inventory types
 * (talents, spells, ancestries…) are collected into a trailing "Other"
 * group so nothing is ever silently hidden.
 * @param {object[]} items  localized stash entries
 * @returns {Array<{key: string, label: string, items: object[]}>}
 */
function _groupStashItems(items) {
  const buckets = new Map();
  let other = null;
  for (const item of items) {
    const key = item.type ?? "unknown";
    if (!_isInventoryType(key)) {
      other ??= {
        key: "other",
        label: game.i18n.localize("CRUCIBLE_PARTY_STASH.GroupOther"),
        items: []
      };
      other.items.push(item);
      continue;
    }
    if (!buckets.has(key)) buckets.set(key, { key, label: item.typeLabel, items: [] });
    buckets.get(key).items.push(item);
  }
  const known = [];
  const rest = [];
  for (const group of buckets.values()) {
    (TYPE_GROUP_ORDER.includes(group.key) ? known : rest).push(group);
  }
  known.sort((a, b) => TYPE_GROUP_ORDER.indexOf(a.key) - TYPE_GROUP_ORDER.indexOf(b.key));
  rest.sort((a, b) => a.label.localeCompare(b.label));
  if (other) rest.push(other);
  return [...known, ...rest];
}

/**
 * Whether the acting user can write to at least one party member.
 * Giving an item creates an Item on the *recipient*, so it is gated on
 * ownership of the recipient — not on ownership of the group actor.
 * GMs pass implicitly (they hold OWNER on everything).
 * @param {Actor} groupActor
 * @returns {boolean}
 */
function _canGiveToAnyone(groupActor) {
  const members = _resolveGroupMembers(groupActor);
  const writable = members.filter(a => a.testUserPermission(game.user, "OWNER"));
  _log("_canGiveToAnyone", {
    memberCount: members.length,
    writableCount: writable.length,
    writable: writable.map(a => a.name)
  });
  return writable.length > 0;
}

/* ─── Render the stash panel HTML ─── */

async function _renderStashHTML(items, isEditable, groupActor) {
  const localized = items.map(item => ({
    ...item,
    typeLabel: CONFIG.Item.typeLabels?.[item.type]
      ? game.i18n.localize(CONFIG.Item.typeLabels[item.type])
      : item.type,
    isStackable: _isStackable(item)
  }));
  const groups = _groupStashItems(localized);
  _log("_renderStashHTML", {
    isEditable,
    itemCount: items.length,
    physicalTypes: SYSTEM?.ITEM?.PHYSICAL_ITEM_TYPES
      ? Array.from(SYSTEM.ITEM.PHYSICAL_ITEM_TYPES)
      : "UNAVAILABLE — using fallback list",
    groups: groups.map(g => ({ key: g.key, label: g.label, count: g.items.length }))
  });
  try {
    // Denomination chips render highest-value first (pp → cp)
    const currencyList = Object.entries(crucible?.CONFIG?.currency ?? {})
      .toSorted((a, b) => b[1].multiplier - a[1].multiplier)
      .map(([key, denom]) => ({ key, ...denom }));
    return await foundry.applications.handlebars.renderTemplate(
      TEMPLATE_STASH,
      {
        items: localized, groups, isEmpty: items.length === 0, isEditable,
        pool: _getCurrency(groupActor),
        shapedCurrency: _isShapedCurrency(),
        currencyList,
        isGM: game.user.isGM,
        canGive: _canGiveToAnyone(groupActor),
        formatCurrency: _formatCurrency
      }
    );
  } catch (err) {
    console.error(`${MODULE_ID} | Template render failed`, err);
    return `<div class="stash-empty">
      <p><i class="fa-solid fa-exclamation-triangle"></i> ${game.i18n.localize("CRUCIBLE_PARTY_STASH.TemplateError")}</p>
    </div>`;
  }
}

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
    // stopPropagation prevents the sheet's own drop handler from firing.
    // This runs before JSON parsing, so even non-Item drops onto the
    // stash tab are suppressed — harmless since the stash panel doesn't
    // need to handle other drop types.
    ev.stopPropagation();
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

/* ─── Edit quantity ───
 * Prompt for a new quantity for a stackable stash entry, then write it
 * under the lock. Dialog happens outside the lock; the entry is
 * re-validated inside since it may have changed while the dialog was open.
 */

async function _editStashQuantity(groupActor, stashId) {
  // Read outside lock for dialog — entry snapshot may be stale, validated inside lock
  const stash = _readStash(groupActor);
  const entry = stash.find(e => e._stashId === stashId);
  if (!entry) return;

  const currentQty = entry.system?.quantity ?? 1;
  const newQty = await _promptQuantity(
    game.i18n.localize("CRUCIBLE_PARTY_STASH.EditQuantityLabel"),
    Number.MAX_SAFE_INTEGER,
    game.i18n.localize("CRUCIBLE_PARTY_STASH.EditQuantityTitle"),
    currentQty
  );
  if (newQty === null || newQty === currentQty) return;

  const updated = await _withStashLock(groupActor.id, async () => {
    const s = _getStash(groupActor);
    const idx = s.findIndex(e => e._stashId === stashId);
    if (idx === -1) return null;
    s[idx].system.quantity = newQty;
    const sheet = groupActor.sheet;
    if (sheet) sheet._stashActiveTab = "stash";
    await _setStash(groupActor, s);
    return s[idx];
  });

  if (updated) {
    ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.QuantityUpdated", {
      name: updated.name, quantity: newQty
    }));
  }
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
    _log("click", {
      target: ev.target,
      matchedAction: el?.dataset?.stashAction ?? null,
      stashId: el?.dataset?.stashId ?? null,
      stashTabConnected: stashTab.isConnected
    });
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();

    const action = el.dataset.stashAction;
    const stashId = el.dataset.stashId;

    if (action === "currencyTake") {
      await _takeCurrency(groupActor);
      return;
    }

    if (action === "currencyDeposit") {
      await _depositCurrency(groupActor);
      return;
    }

    if (action === "currencySplit") {
      await _splitCurrency(groupActor);
      return;
    }

    if (action === "currencyCreate") {
      await _createCurrency(groupActor);
      return;
    }

    if (action === "currencyExchange") {
      await _exchangeCurrency(groupActor);
      return;
    }

    if (action === "editQty") {
      await _editStashQuantity(groupActor, stashId);
      return;
    }

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
      const actors = _resolveGroupMembers(groupActor);

      if (!actors.length) {
        ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoMembers"));
        return;
      }

      // Giving creates an Item on the recipient, so only characters this user
      // can actually write to are offered. Without this filter the picker
      // lists every party member and the transfer fails silently for any the
      // user doesn't own — the most common case being a player who owns the
      // group sheet but not their party members' sheets.
      const writable = actors.filter(a => a.testUserPermission(game.user, "OWNER"));
      _log("give: recipient candidates", {
        total: actors.length,
        writable: writable.length,
        names: writable.map(a => a.name)
      });
      if (!writable.length) {
        _log("give: ABORT — no writable recipient");
        ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoOwnedCharacter"));
        return;
      }

      const choices = {};
      for (const actor of writable) choices[actor.id] = actor.name;
      const recipient = await _pickRecipient(choices);
      if (!recipient) return;

      const target = game.actors.get(recipient);
      if (!target) { ui.notifications.error(game.i18n.localize("CRUCIBLE_PARTY_STASH.RecipientNotFound")); return; }

      try {
        const name = await _initiateTransferToActor(groupActor, stashId, target);
        if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemGiven", { name, target: target.name }));
      } catch (err) {
        // _withStashLock logs and rethrows; without this the rejection is
        // unhandled and the click appears to do nothing at all.
        console.error(`${MODULE_ID} | Give to ${target.name} failed`, err);
        ui.notifications.error(game.i18n.format("CRUCIBLE_PARTY_STASH.GiveFailed", { target: target.name }));
      }
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

export { _renderStashHTML, _activateStashDropListeners, _activateStashActionListeners };