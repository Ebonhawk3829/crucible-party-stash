/* ─── Stash Transfer Subsystem ───────────────────────────────────
 * Transfer workflows: stash→hero and hero→stash, plus the two
 * drop entry points (capturing-phase listener for V2 sheets and
 * dropActorSheetData hook for V1 compatibility).
 *
 * The _handledStashDrops Set lives here alongside both consumers
 * so the contract between the capturing listener and the hook is
 * explicit and co-located.
 * ──────────────────────────────────────────────────────────────── */

import {
  MODULE_ID,
  _readStash, _getStash, _setStash,
  _isStackable, _stashEntryMatches, _withStashLock
} from "./stash-data.mjs";

/* Prevent double-fire when both the capturing drop listener and
 * dropActorSheetData hook process the same stash→hero drag. */
const _handledStashDrops = new Set();

/**
 * Prompt the user for a quantity between 1 and max inclusive.
 *
 * NOTE: Uses document.getElementById() to retrieve the input from
 * the dialog callback. This works because DialogV2 renders into the
 * main document body. If Foundry ever moves dialogs to a detached
 * window or shadow DOM, switch to `button.form?.elements`.
 *
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

/* ─── Stash → character (V1 dropActorSheetData hook) ───
 * Hook registration is in main.mjs; this is the pure handler. */

export async function onDropActorSheetData(targetActor, sheet, data) {
  if (!data?.fromStash || data.groupActorId === targetActor.id) return;
  if (_handledStashDrops.has(data.stashId)) return;
  const groupActor = game.actors.get(data.groupActorId);
  if (!groupActor) return;

  const name = await _initiateTransferToActor(groupActor, data.stashId, targetActor);
  if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemMovedTo", { name, target: targetActor.name }));
}

/* ─── Stash → V2 hero sheet (direct drop interception) ─── */

export function _setupHeroDropInterception(app, element) {
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

/* Re-export for stash-ui.mjs (the Give button uses these) */
export { _promptQuantity, _pickRecipient, _initiateTransferToActor };