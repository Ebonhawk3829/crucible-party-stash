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
  _isStackable, _stashEntryMatches, _withStashLock,
  _getCurrency, _setCurrency, _addCurrency, _subtractCurrency,
  _formatCurrency, _resolveGroupMembers, _isShapedCurrency
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

async function _pickRecipient(choices, title) {
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
        title: title ?? game.i18n.localize("CRUCIBLE_PARTY_STASH.GiveItem"),
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

/* ─── Currency: denomination input dialog ───
 * Shared builder for all currency flows. Renders one number input per
 * configured denomination (pp/gp/sp/cp, icons from crucible.CONFIG.currency)
 * so users enter currency the way they think about it. Values are NOT
 * auto-simplified — what you type per field is what's used per field.
 *
 * @param {object} [opts]
 * @param {Record<string, number>|number} [opts.max]      shaped/number cap; per-field max in shaped mode, base-unit max in shapeless mode
 * @param {Record<string, number>|number} [opts.show]    balance to display as a breakdown above the fields
 * @returns {Promise<Record<string, number>|null>} shaped amounts, or null on cancel
 */
async function _promptCurrencyAmount(title, label, { max, show } = {}) {
  const cfg = crucible?.CONFIG?.currency ?? {};
  const denominations = Object.entries(cfg).toSorted((a, b) => b[1].multiplier - a[1].multiplier);
  const shaped = _isShapedCurrency();
  const maxShape = (max !== undefined)
    ? ((typeof max === "object") ? max : null)
    : null;
  const maxBase = (typeof max === "number") ? max : (maxShape ? null : undefined);
  const showShape = (show !== undefined)
    ? ((typeof show === "object") ? show : crucible.api.documents.CrucibleActor.allocateCurrency(Math.max(show, 0)))
    : null;

  const uid = foundry.utils.randomID();
  const fields = denominations.map(([key, denom]) => {
    const fieldMax = shaped && maxShape ? `max="${maxShape[key] ?? 0}"` : "";
    const value = shaped && maxShape ? (maxShape[key] ?? 0) : 0;
    const icon = denom.icon
      ? `<img class="denom-icon" src="${denom.icon}" alt="${game.i18n.localize(denom.label)}" data-tooltip="${game.i18n.localize(denom.label)}">`
      : `<span class="denom-abbr">${game.i18n.localize(denom.abbreviation)}</span>`;
    return `<div class="form-group stash-denom-field">
      <label>${icon}</label>
      <div class="form-fields">
        <input id="stash-denom-${key}-${uid}" type="number" name="denom-${key}"
               min="0" ${fieldMax} value="${value}" data-denom="${key}">
      </div>
    </div>`;
  }).join("");

  const showHint = showShape !== null
    ? `<p class="hint">${game.i18n.format("CRUCIBLE_PARTY_STASH.CurrencyAvailable",
        { amount: _formatCurrency(showShape) })}</p>`
    : "";

  const contentHTML = `<div class="stash-dialog-content stash-currency-dialog">
    ${showHint}
    ${fields}
  </div>`;

  try {
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title, icon: "fa-solid fa-coins" },
      content: contentHTML,
      ok: {
        label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Give"),
        icon: "fa-solid fa-check",
        callback: (event, button) => {
          const amounts = {};
          let any = false;
          for (const [key] of denominations) {
            const input = document.getElementById(`stash-denom-${key}-${uid}`);
            const v = input ? Number(input.value) : 0;
            if (!Number.isFinite(v) || v < 0) return null;
            const n = Math.trunc(v);
            amounts[key] = n;
            if (n > 0) any = true;
          }
          // Shapeless mode: validate the base-unit total against the cap
          if (!shaped && maxBase !== undefined && maxBase !== null) {
            const total = crucible.api.documents.CrucibleActor.convertCurrency(amounts);
            if (total > maxBase) return null;
          }
          return any ? amounts : null;
        }
      },
      rejectClose: false
    });
    return result ?? null;
  } catch (err) {
    console.error(`${MODULE_ID} | _promptCurrencyAmount error:`, err);
    return null;
  }
}

/* ─── Currency: Take ───
 * Player-facing withdrawal. Prompts for per-denomination amounts, then moves
 * them from the pool to the acting user's designated character.
 *
 * Shaped mode: each field is bounded by the pool's contents of that
 * denomination; the subtraction is per-denomination and fails if any field
 * exceeds what's in the pool (e.g. another user drained it meanwhile).
 *
 * Shapeless mode: fields are summed to base units and bounded by the pool's
 * total; the pool re-allocates greedily after subtraction.
 */

async function _takeCurrency(groupActor) {
  const pool = _getCurrency(groupActor);
  if (_shapeToBaseLocal(pool) <= 0) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.PoolEmpty"));
    return;
  }

  const amounts = await _promptCurrencyAmount(
    game.i18n.localize("CRUCIBLE_PARTY_STASH.TakeCurrencyTitle"),
    game.i18n.localize("CRUCIBLE_PARTY_STASH.TakeCurrencyLabel"),
    { max: pool, show: pool }
  );
  if (!amounts) return;

  const newPool = await _subtractCurrency(groupActor, amounts);
  if (!newPool) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.PoolInsufficient",
      { available: _formatCurrency(_getCurrency(groupActor)) }));
    return;
  }

  // Credit the acting user's character. If they own exactly one group member,
  // credit it directly; otherwise let them pick.
  const members = _resolveGroupMembers(groupActor);
  const owned = members.filter(a => a.testUserPermission(game.user, "OWNER"));
  let target = owned.length === 1 ? owned[0] : null;
  if (!target) {
    if (!owned.length) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoOwnedCharacter"));
      // Refund — the pool subtraction already happened
      await _addCurrency(groupActor, amounts);
      return;
    }
    const picked = await _pickRecipient(
      Object.fromEntries(owned.map(a => [a.id, a.name])),
      game.i18n.localize("CRUCIBLE_PARTY_STASH.TakeCurrencyTitle")
    );
    if (!picked) {
      await _addCurrency(groupActor, amounts);
      return;
    }
    target = game.actors.get(picked);
    if (!target) {
      await _addCurrency(groupActor, amounts);
      return;
    }
  }

  const applied = await target.modifyCurrency(crucible.api.documents.CrucibleActor.convertCurrency(amounts));
  const appliedBase = Math.max(applied, 0);
  const requestedBase = crucible.api.documents.CrucibleActor.convertCurrency(amounts);
  if (appliedBase < requestedBase) {
    // Shouldn't happen (modifyCurrency only clamps at 0 and we're adding),
    // but refund the difference to the pool if it somehow does.
    const shortfall = requestedBase - appliedBase;
    const refund = crucible.api.documents.CrucibleActor.allocateCurrency(shortfall);
    await _addCurrency(groupActor, refund);
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.CurrencyPartial"));
  }
  ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.CurrencyTaken", {
    amount: _formatCurrency(amounts), target: target.name
  }));
}

/** Local base-unit sum helper (avoids importing a private from the data layer). */
function _shapeToBaseLocal(shape) {
  const cfg = crucible?.CONFIG?.currency ?? {};
  let total = 0;
  for (const [key, count] of Object.entries(shape)) total += (count ?? 0) * (cfg[key]?.multiplier ?? 0);
  return total;
}

/* ─── Currency: Split ───
 * GM-only distribution. Prompts for per-denomination amounts and a checklist
 * of members, then divides evenly.
 *
 * Shaped mode: each denomination is divided independently (integer floor);
 * any remainder of a denomination stays in the pool rather than being
 * force-assigned — you can't split 1pp three ways without making change.
 *
 * Shapeless mode: the entered amounts are summed to base units, divided
 * evenly, and remainder units are assigned to checked members in list order
 * until exhausted, so the full amount always distributes.
 */

async function _splitCurrency(groupActor) {
  const members = _resolveGroupMembers(groupActor);
  if (!members.length) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoMembers"));
    return;
  }

  const pool = _getCurrency(groupActor);
  const shaped = _isShapedCurrency();
  const { amounts, selected } = await _splitCurrencyDialog(members, pool, shaped);
  if (!amounts || !selected.length) return;

  // Compute per-member shares
  const shares = new Map();
  let remainderShape = null;
  if (shaped) {
    for (const id of selected) {
      shares.set(id, Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, Math.floor(v / selected.length)])));
    }
    remainderShape = Object.fromEntries(
      Object.entries(amounts).map(([k, v]) => [k, v - Math.floor(v / selected.length) * selected.length])
    );
  } else {
    const totalBase = crucible.api.documents.CrucibleActor.convertCurrency(amounts);
    const per = Math.floor(totalBase / selected.length);
    let remainder = totalBase - (per * selected.length);
    for (const id of selected) {
      const share = per + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      shares.set(id, crucible.api.documents.CrucibleActor.allocateCurrency(share));
    }
  }

  const distributed = await _subtractCurrency(groupActor, amounts);
  if (!distributed) {
    ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.PoolInsufficient", {
      available: _formatCurrency(_getCurrency(groupActor))
    }));
    return;
  }

  // Credit each selected member. Track failures so the pool can be refunded
  // for any share that couldn't be delivered.
  let failedRefund = null;
  for (const [actorId, share] of shares) {
    const actor = game.actors.get(actorId);
    if (!actor) {
      failedRefund = failedRefund ?? {};
      for (const [k, v] of Object.entries(share)) failedRefund[k] = (failedRefund[k] ?? 0) + v;
      continue;
    }
    const applied = await actor.modifyCurrency(crucible.api.documents.CrucibleActor.convertCurrency(share));
    const appliedBase = Math.max(applied, 0);
    const requestedBase = crucible.api.documents.CrucibleActor.convertCurrency(share);
    if (appliedBase < requestedBase) {
      const refund = crucible.api.documents.CrucibleActor.allocateCurrency(requestedBase - appliedBase);
      failedRefund = failedRefund ?? {};
      for (const [k, v] of Object.entries(refund)) failedRefund[k] = (failedRefund[k] ?? 0) + v;
    }
    ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.CurrencySplitTo", {
      amount: _formatCurrency(share), target: actor.name
    }));
  }

  // Refund failed deliveries plus (shaped mode) the unsplit remainder
  const refundShape = failedRefund ?? {};
  if (remainderShape) {
    for (const [k, v] of Object.entries(remainderShape)) refundShape[k] = (refundShape[k] ?? 0) + v;
  }
  if (Object.values(refundShape).some(v => v > 0)) {
    await _addCurrency(groupActor, refundShape);
  }
  if (failedRefund) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.CurrencyPartial"));
  }
}

/* ─── Split dialog: denomination amounts + member checklist ─── */

async function _splitCurrencyDialog(members, pool, shaped) {
  const uid = foundry.utils.randomID();
  const cfg = crucible?.CONFIG?.currency ?? {};
  const denominations = Object.entries(cfg).toSorted((a, b) => b[1].multiplier - a[1].multiplier);
  const checkboxes = members.map((m, i) => `
    <div class="form-group stash-split-member">
      <label>
        <input type="checkbox" name="member" value="${m.id}" ${i === 0 ? "checked" : ""}>
        ${m.name}
      </label>
    </div>`).join("");
  const fields = denominations.map(([key, denom]) => {
    const fieldMax = shaped ? `max="${pool[key] ?? 0}"` : "";
    const value = shaped ? (pool[key] ?? 0) : 0;
    const icon = denom.icon
      ? `<img class="denom-icon" src="${denom.icon}" alt="${game.i18n.localize(denom.label)}" data-tooltip="${game.i18n.localize(denom.label)}">`
      : `<span class="denom-abbr">${game.i18n.localize(denom.abbreviation)}</span>`;
    return `<div class="form-group stash-denom-field">
      <label>${icon}</label>
      <div class="form-fields">
        <input id="stash-split-${key}-${uid}" type="number" name="denom-${key}"
               min="0" ${fieldMax} value="${value}" data-denom="${key}">
      </div>
    </div>`;
  }).join("");
  const contentHTML = `<div class="stash-dialog-content stash-split-dialog">
    <p class="hint">${game.i18n.format("CRUCIBLE_PARTY_STASH.SplitPoolHint", { pool: _formatCurrency(pool) })}</p>
    ${fields}
    <fieldset class="stash-split-members">
      <legend>${game.i18n.localize("CRUCIBLE_PARTY_STASH.SplitMembers")}</legend>
      ${checkboxes}
    </fieldset>
  </div>`;

  try {
    const result = await foundry.applications.api.DialogV2.prompt({
      window: {
        title: game.i18n.localize("CRUCIBLE_PARTY_STASH.SplitCurrencyTitle"),
        icon: "fa-solid fa-coins"
      },
      content: contentHTML,
      ok: {
        label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Split"),
        icon: "fa-solid fa-coins",
        callback: (event, button) => {
          const amounts = {};
          let any = false;
          for (const [key] of denominations) {
            const input = document.getElementById(`stash-split-${key}-${uid}`);
            const v = input ? Number(input.value) : 0;
            if (!Number.isFinite(v) || v < 0) return null;
            const n = Math.trunc(v);
            amounts[key] = n;
            if (n > 0) any = true;
          }
          if (!any) return null;
          // Shapeless mode: validate base-unit total against the pool
          if (!shaped) {
            const total = crucible.api.documents.CrucibleActor.convertCurrency(amounts);
            if (total > crucible.api.documents.CrucibleActor.convertCurrency(pool)) return null;
          }
          const selected = [...button.form.querySelectorAll("input[name='member']:checked")]
            .map(cb => cb.value);
          return { amounts, selected };
        }
      },
      rejectClose: false
    });
    return result ?? { amounts: null, selected: [] };
  } catch (err) {
    console.error(`${MODULE_ID} | _splitCurrencyDialog error:`, err);
    return { amounts: null, selected: [] };
  }
}

/* ─── Currency: Deposit ───
 * Player-facing reverse of Take. Prompts for an amount bounded by the
 * acting user's owned character's funds, deducts from the character, and
 * adds to the pool. The character is deducted first (modifyCurrency clamps
 * at 0 and returns the applied delta) so the pool only ever receives what
 * was actually taken from the character.
 */

async function _depositCurrency(groupActor) {
  // Resolve the acting user's character: auto-target if they own exactly
  // one group member, otherwise let them pick.
  const members = _resolveGroupMembers(groupActor);
  const owned = members.filter(a => a.testUserPermission(game.user, "OWNER"));
  let source = owned.length === 1 ? owned[0] : null;
  if (!source) {
    if (!owned.length) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoOwnedCharacter"));
      return;
    }
    const picked = await _pickRecipient(
      Object.fromEntries(owned.map(a => [a.id, a.name])),
      game.i18n.localize("CRUCIBLE_PARTY_STASH.DepositCurrencyTitle")
    );
    if (!picked) return;
    source = game.actors.get(picked);
    if (!source) return;
  }

  const funds = source.system.currency ?? 0;
  if (funds <= 0) {
    ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.CharacterBroke", { target: source.name }));
    return;
  }

  // In shaped mode, the deposit is bounded per-denomination by the
  // character's allocated balance — you can deposit the 3sp you visibly
  // have, not 30sp "worth". In shapeless mode the fields are summed and
  // bounded by the character's base-unit total.
  const shaped = _isShapedCurrency();
  const fundsShape = shaped
    ? crucible.api.documents.CrucibleActor.allocateCurrency(funds)
    : undefined;
  const amounts = await _promptCurrencyAmount(
    game.i18n.localize("CRUCIBLE_PARTY_STASH.DepositCurrencyTitle"),
    game.i18n.localize("CRUCIBLE_PARTY_STASH.DepositCurrencyLabel"),
    { max: shaped ? fundsShape : funds, show: funds }
  );
  if (!amounts) return;

  const requestedBase = crucible.api.documents.CrucibleActor.convertCurrency(amounts);

  // Deduct from the character first. modifyCurrency returns the applied
  // delta (negative for a deduction, 0 if the actor had no funds to take).
  const applied = await source.modifyCurrency(-requestedBase);
  const depositedBase = Math.abs(Math.min(applied, 0));
  if (!depositedBase) return;

  // Credit the pool with what was actually deducted. In shaped mode the
  // deposit enters as the exact denominations entered (the character's
  // allocated balance guaranteed them sufficient); in shapeless mode the
  // pool re-allocates greedily anyway.
  await _addCurrency(groupActor, shaped ? amounts : crucible.api.documents.CrucibleActor.allocateCurrency(depositedBase));
  ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.CurrencyDeposited", {
    amount: _formatCurrency(shaped ? amounts : crucible.api.documents.CrucibleActor.allocateCurrency(depositedBase)),
    target: source.name
  }));
}

/* ─── Currency: Create (GM) ───
 * GM-only mint. Prompts for per-denomination amounts with no upper bound
 * and adds them directly to the pool without touching any character's funds.
 */

async function _createCurrency(groupActor) {
  const amounts = await _promptCurrencyAmount(
    game.i18n.localize("CRUCIBLE_PARTY_STASH.CreateCurrencyTitle"),
    game.i18n.localize("CRUCIBLE_PARTY_STASH.CreateCurrencyLabel")
  );
  if (!amounts) return;

  await _addCurrency(groupActor, amounts);
  ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.CurrencyCreated", {
    amount: _formatCurrency(amounts)
  }));
}

/* ─── Currency: Exchange (GM, shaped mode only) ───
 * Explicit money-changing. Converts one denomination into another at
 * configured multipliers (e.g. 1pp → 10gp). Only offered in shaped mode —
 * in shapeless mode the pool is an abstract purse and exchange is
 * meaningless.
 */

async function _exchangeCurrency(groupActor) {
  const pool = _getCurrency(groupActor);
  const cfg = crucible?.CONFIG?.currency ?? {};
  const denominations = Object.entries(cfg).toSorted((a, b) => b[1].multiplier - a[1].multiplier);
  if (denominations.length < 2) return;

  const { from, to, amount } = await _exchangeCurrencyDialog(denominations, pool);
  if (!from || !to || !amount) return;

  const fromMult = cfg[from].multiplier;
  const toMult = cfg[to].multiplier;
  if (fromMult <= toMult) return; // only downward conversion (pp→gp, gp→sp, …)

  const converted = Math.floor((amount * fromMult) / toMult);
  if (converted <= 0) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.ExchangeNothing"));
    return;
  }

  const take = { [from]: amount };
  const give = { [to]: converted };
  const newPool = await _subtractCurrency(groupActor, take);
  if (!newPool) {
    ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.PoolInsufficient", {
      available: _formatCurrency(_getCurrency(groupActor))
    }));
    return;
  }
  await _addCurrency(groupActor, give);
  ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ExchangeDone", {
    fromAmount: `${amount}${game.i18n.localize(cfg[from].abbreviation)}`,
    toAmount: `${converted}${game.i18n.localize(cfg[to].abbreviation)}`
  }));
}

/* ─── Exchange dialog: from / to / amount ─── */

async function _exchangeCurrencyDialog(denominations, pool) {
  const uid = foundry.utils.randomID();
  const options = denominations.map(([key, denom]) => {
    const label = denom.icon
      ? `<img class="denom-icon" src="${denom.icon}" alt=""> ${game.i18n.localize(denom.abbreviation)}`
      : game.i18n.localize(denom.abbreviation);
    return `<option value="${key}">${label} — ${pool[key] ?? 0} available</option>`;
  }).join("");
  const contentHTML = `<div class="stash-dialog-content stash-exchange-dialog">
    <div class="form-group">
      <label>${game.i18n.localize("CRUCIBLE_PARTY_STASH.ExchangeFrom")}</label>
      <div class="form-fields">
        <select id="stash-ex-from-${uid}">${options}</select>
      </div>
    </div>
    <div class="form-group">
      <label>${game.i18n.localize("CRUCIBLE_PARTY_STASH.ExchangeTo")}</label>
      <div class="form-fields">
        <select id="stash-ex-to-${uid}">${options}</select>
      </div>
    </div>
    <div class="form-group">
      <label>${game.i18n.localize("CRUCIBLE_PARTY_STASH.ExchangeAmount")}</label>
      <div class="form-fields">
        <input id="stash-ex-amt-${uid}" type="number" min="1" value="1">
      </div>
    </div>
  </div>`;

  try {
    const result = await foundry.applications.api.DialogV2.prompt({
      window: {
        title: game.i18n.localize("CRUCIBLE_PARTY_STASH.ExchangeTitle"),
        icon: "fa-solid fa-right-left"
      },
      content: contentHTML,
      ok: {
        label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Exchange"),
        icon: "fa-solid fa-right-left",
        callback: () => {
          const from = document.getElementById(`stash-ex-from-${uid}`)?.value;
          const to = document.getElementById(`stash-ex-to-${uid}`)?.value;
          const amount = Math.trunc(Number(document.getElementById(`stash-ex-amt-${uid}`)?.value ?? 0));
          if (!from || !to || !Number.isFinite(amount) || amount < 1) return null;
          return { from, to, amount };
        }
      },
      rejectClose: false
    });
    return result ?? { from: null, to: null, amount: 0 };
  } catch (err) {
    console.error(`${MODULE_ID} | _exchangeCurrencyDialog error:`, err);
    return { from: null, to: null, amount: 0 };
  }
}

/* Re-export for stash-ui.mjs (the Give button uses these) */
export { _promptQuantity, _pickRecipient, _initiateTransferToActor, _takeCurrency, _splitCurrency, _depositCurrency, _createCurrency, _exchangeCurrency };