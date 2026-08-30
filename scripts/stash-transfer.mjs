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
  _getCurrency, _setCurrency, _formatCurrency, _resolveGroupMembers
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

/* ─── Currency: Take ───
 * Player-facing withdrawal. Prompts for an amount, then moves it from the
 * pool to the acting user's designated character. Under the lock, the pool
 * is clamped to what's actually available — if another user drained the
 * pool while the dialog was open, the taker gets what remains.
 */

async function _takeCurrency(groupActor) {
  const pool = _getCurrency(groupActor);
  if (pool <= 0) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.PoolEmpty"));
    return;
  }

  const amount = await _promptQuantity(
    game.i18n.localize("CRUCIBLE_PARTY_STASH.TakeCurrencyLabel"),
    pool,
    game.i18n.localize("CRUCIBLE_PARTY_STASH.TakeCurrencyTitle"),
    pool
  );
  if (!amount) return;

  const taken = await _withStashLock(groupActor.id, async () => {
    const current = _getCurrency(groupActor);
    const actual = Math.min(amount, current);
    if (actual <= 0) return 0;
    await _setCurrency(groupActor, current - actual);
    return actual;
  });

  if (!taken) return;

  // Credit the acting user's character. If they own exactly one group member,
  // credit it directly; otherwise let them pick.
  const members = _resolveGroupMembers(groupActor);
  const owned = members.filter(a => a.testUserPermission(game.user, "OWNER"));
  let target = owned.length === 1 ? owned[0] : null;
  if (!target) {
    if (!owned.length) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoOwnedCharacter"));
      return;
    }
    const picked = await _pickRecipient(
      Object.fromEntries(owned.map(a => [a.id, a.name])),
      game.i18n.localize("CRUCIBLE_PARTY_STASH.TakeCurrencyTitle")
    );
    if (!picked) return;
    target = game.actors.get(picked);
    if (!target) return;
  }

  const applied = await target.modifyCurrency(taken);
  if (applied < taken) {
    // Shouldn't happen (modifyCurrency only clamps at 0 and we're adding),
    // but refund the difference to the pool if it somehow does.
    await _withStashLock(groupActor.id, async () => {
      await _setCurrency(groupActor, _getCurrency(groupActor) + (taken - applied));
    });
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.CurrencyPartial"));
  }
  ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.CurrencyTaken", {
    amount: _formatCurrency(taken), target: target.name
  }));
}

/* ─── Currency: Split ───
 * GM-only distribution. Prompts for a total amount and a checklist of
 * members, then divides evenly. Remainder units (base currency doesn't
 * always divide cleanly) are assigned to checked members in list order
 * until exhausted, so the full amount is always distributed.
 */

async function _splitCurrency(groupActor) {
  const members = _resolveGroupMembers(groupActor);
  if (!members.length) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.NoMembers"));
    return;
  }

  const pool = _getCurrency(groupActor);
  const { amount, selected } = await _splitCurrencyDialog(members, pool);
  if (!amount || !selected.length) return;

  const per = Math.floor(amount / selected.length);
  let remainder = amount - (per * selected.length);
  const shares = new Map(selected.map(id => [id, per]));
  for (const id of selected) {
    if (remainder <= 0) break;
    shares.set(id, shares.get(id) + 1);
    remainder--;
  }

  const distributed = await _withStashLock(groupActor.id, async () => {
    const current = _getCurrency(groupActor);
    const actual = Math.min(amount, current);
    if (actual < amount) {
      ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.PoolInsufficient", {
        available: _formatCurrency(current)
      }));
      return 0;
    }
    await _setCurrency(groupActor, current - actual);
    return actual;
  });
  if (!distributed) return;

  // Credit each selected member. Track failures so the pool can be refunded
  // for any share that couldn't be delivered.
  let failedTotal = 0;
  for (const [actorId, share] of shares) {
    const actor = game.actors.get(actorId);
    if (!actor) { failedTotal += share; continue; }
    const applied = await actor.modifyCurrency(share);
    if (applied < share) failedTotal += (share - applied);
    ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.CurrencySplitTo", {
      amount: _formatCurrency(share), target: actor.name
    }));
  }

  if (failedTotal > 0) {
    await _withStashLock(groupActor.id, async () => {
      await _setCurrency(groupActor, _getCurrency(groupActor) + failedTotal);
    });
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_PARTY_STASH.CurrencyPartial"));
  }
}

/* ─── Split dialog: amount + member checklist ─── */

async function _splitCurrencyDialog(members, pool) {
  const amountId = `stash-split-amt-${foundry.utils.randomID()}`;
  const checkboxes = members.map((m, i) => `
    <div class="form-group stash-split-member">
      <label>
        <input type="checkbox" name="member" value="${m.id}" ${i === 0 ? "checked" : ""}>
        ${m.name}
      </label>
    </div>`).join("");
  const contentHTML = `<div class="stash-dialog-content stash-split-dialog">
    <div class="form-group">
      <label>${game.i18n.localize("CRUCIBLE_PARTY_STASH.SplitAmountLabel")}</label>
      <div class="form-fields">
        <input id="${amountId}" type="number" name="amount" min="1" max="${pool}" value="${pool}" autofocus>
      </div>
      <p class="hint">${game.i18n.format("CRUCIBLE_PARTY_STASH.SplitPoolHint", { pool: _formatCurrency(pool) })}</p>
    </div>
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
          const input = document.getElementById(amountId);
          const amount = input ? Number(input.value) : 0;
          if (!Number.isFinite(amount) || amount < 1) return null;
          const selected = [...button.form.querySelectorAll("input[name='member']:checked")]
            .map(cb => cb.value);
          return { amount: Math.trunc(amount), selected };
        }
      },
      rejectClose: false
    });
    return result ?? { amount: 0, selected: [] };
  } catch (err) {
    console.error(`${MODULE_ID} | _splitCurrencyDialog error:`, err);
    return { amount: 0, selected: [] };
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

  const amount = await _promptQuantity(
    game.i18n.localize("CRUCIBLE_PARTY_STASH.DepositCurrencyLabel"),
    funds,
    game.i18n.localize("CRUCIBLE_PARTY_STASH.DepositCurrencyTitle"),
    funds
  );
  if (!amount) return;

  // Deduct from the character first. modifyCurrency returns the applied
  // delta (negative for a deduction, 0 if the actor had no funds to take).
  const applied = await source.modifyCurrency(-amount);
  const deposited = Math.abs(Math.min(applied, 0));
  if (!deposited) return;

  await _withStashLock(groupActor.id, async () => {
    await _setCurrency(groupActor, _getCurrency(groupActor) + deposited);
  });
  ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.CurrencyDeposited", {
    amount: _formatCurrency(deposited), target: source.name
  }));
}

/* ─── Currency: Create (GM) ───
 * GM-only mint. Prompts for an amount with no upper bound and adds it
 * directly to the pool without touching any character's funds.
 */

async function _createCurrency(groupActor) {
  const amount = await _promptQuantity(
    game.i18n.localize("CRUCIBLE_PARTY_STASH.CreateCurrencyLabel"),
    Number.MAX_SAFE_INTEGER,
    game.i18n.localize("CRUCIBLE_PARTY_STASH.CreateCurrencyTitle"),
    100
  );
  if (!amount) return;

  await _withStashLock(groupActor.id, async () => {
    await _setCurrency(groupActor, _getCurrency(groupActor) + amount);
  });
  ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.CurrencyCreated", {
    amount: _formatCurrency(amount)
  }));
}

/* Re-export for stash-ui.mjs (the Give button uses these) */
export { _promptQuantity, _pickRecipient, _initiateTransferToActor, _takeCurrency, _splitCurrency, _depositCurrency, _createCurrency };