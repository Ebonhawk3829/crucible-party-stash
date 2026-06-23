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
  _isStackable, _stashEntryMatches, _withStashLock
} from "./stash-data.mjs";
import {
  _promptQuantity, _pickRecipient, _initiateTransferToActor
} from "./stash-transfer.mjs";

export const TEMPLATE_STASH = `modules/${MODULE_ID}/templates/stash-panel.hbs`;

/**
 * Resolve the group actor's member list to an array of Actor instances.
 * Crucible's group member schema uses `actorId` as the reference field;
 * `memberArray.actors` is a runtime Set of resolved Actor instances
 * (populated by the system), falling back to raw array iteration.
 * @param {Actor} groupActor
 * @returns {Actor[]}
 */
function _resolveGroupMembers(groupActor) {
  const memberArray = groupActor.system.members ?? [];
  if (memberArray.actors) {
    return Array.from(memberArray.actors);
  }
  return Array.from(memberArray)
    .map(m => game.actors.get(m.actorId ?? m.id))
    .filter(Boolean);
}

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
      const actors = _resolveGroupMembers(groupActor);

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

export { _renderStashHTML, _activateStashDropListeners, _activateStashActionListeners };