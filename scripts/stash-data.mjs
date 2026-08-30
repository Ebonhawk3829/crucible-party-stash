/* ─── Stash Data Layer ───────────────────────────────────────────
 * Pure data access and mutation for the party stash flag.
 * No DOM, no UI, no hooks — just the flag, the lock, and helpers.
 *
 * Every other module in this package imports from here.
 * ──────────────────────────────────────────────────────────────── */

export const MODULE_ID = "crucible-party-stash";

/* ─── Stash Mutex ───
 * Per-actor serialized lock to prevent races from concurrent setFlag calls
 * (double-click, overlapping async operations, multiple group sheets).
 */
const _stashLocks = new Map();

export function _withStashLock(actorId, fn) {
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

export function _readStash(groupActor) {
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

export function _getStash(groupActor) {
  return foundry.utils.deepClone(_readStash(groupActor));
}

export async function _setStash(groupActor, stash) {
  await groupActor.setFlag(MODULE_ID, "stash", stash);
}

export function _checkStashCapacity(stash) {
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
export function _isStackable(itemData) {
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
export function _baseItemName(name) {
  return (name ?? "").replace(/^\(\d+\)\s*/, "");
}

/**
 * Compare two stash entries for merge eligibility.
 * Both must be stackable and share the same base name (stripped of quantity prefix).
 */
export function _stashEntryMatches(a, b) {
  if (!_isStackable(a) || !_isStackable(b)) return false;
  return _baseItemName(a.name) === _baseItemName(b.name);
}

/**
 * Whether the current user meets the minimum role to see and use the stash.
 * GMs always pass.
 * @returns {boolean}
 */
export function canUseStash() {
  if (game.user.isGM) return true;
  const minRole = game.settings.get(MODULE_ID, "minRole");
  return game.user.role >= minRole;
}

/* ─── Currency Pool ───
 * The party currency pool is stored as a shaped object {pp, gp, sp, cp}
 * (zero-filled, all keys present). A world setting (shapedCurrency) selects
 * the pool's semantics:
 *
 *   shaped   (default) — a literal pile of coins. Each denomination is
 *             tracked and spent separately; no automatic conversion. A pool
 *             of 10pp cannot pay a 5gp cost until the GM exchanges.
 *   shapeless           — an abstract purse. The pool is summed to base
 *             units and displayed via greedy allocation, matching how
 *             CrucibleActor stores character currency. Any denomination
 *             can satisfy any amount.
 *
 * Pools written by v1.5.0 (a plain integer) are migrated to shaped form on
 * first read via allocateCurrency.
 */

/** Zero-filled shaped pool in configured denomination order (largest first). */
function _emptyShape() {
  const shape = {};
  for (const key of Object.keys(crucible?.CONFIG?.currency ?? {})) shape[key] = 0;
  return shape;
}

/** Normalize any stored pool value into a zero-filled shaped object. */
function _normalizeShape(raw) {
  const shape = _emptyShape();
  if (Number.isFinite(raw)) {
    // v1.5.0 integer pool — migrate via greedy allocation
    const allocated = crucible.api.documents.CrucibleActor.allocateCurrency(Math.max(Math.trunc(raw), 0));
    for (const key of Object.keys(shape)) shape[key] = allocated[key] ?? 0;
    return shape;
  }
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(shape)) {
      const v = raw[key];
      shape[key] = Number.isFinite(v) ? Math.max(Math.trunc(v), 0) : 0;
    }
  }
  return shape;
}

/** Sum a shaped object into base currency units. */
function _shapeToBase(shape) {
  const cfg = crucible?.CONFIG?.currency ?? {};
  let total = 0;
  for (const [key, count] of Object.entries(shape)) {
    total += (count ?? 0) * (cfg[key]?.multiplier ?? 0);
  }
  return total;
}

/** Whether the pool operates in shaped (per-denomination) mode. */
export function _isShapedCurrency() {
  return game.settings.get(MODULE_ID, "shapedCurrency");
}

/**
 * Read the party currency pool as a zero-filled shaped object.
 * @param {Actor} groupActor
 * @returns {Record<string, number>} {pp, gp, sp, cp} (keys follow crucible.CONFIG.currency)
 */
export function _getCurrency(groupActor) {
  return _normalizeShape(groupActor.getFlag(MODULE_ID, "currency"));
}

/**
 * Write the party currency pool from a shaped object.
 * @param {Actor} groupActor
 * @param {Record<string, number>} shape
 */
export async function _setCurrency(groupActor, shape) {
  await groupActor.setFlag(MODULE_ID, "currency", _normalizeShape(shape));
}

/**
 * Add a shaped amount to the pool. In shapeless mode the amounts are summed
 * to base units and re-allocated greedily (matching v1.5.0 behavior); in
 * shaped mode each denomination is added separately.
 * @param {Actor} groupActor
 * @param {Record<string, number>} amounts  per-denomination counts to add
 */
export async function _addCurrency(groupActor, amounts) {
  const add = _normalizeShape(amounts);
  return _withStashLock(groupActor.id, async () => {
    const current = _getCurrency(groupActor);
    if (_isShapedCurrency()) {
      for (const key of Object.keys(current)) current[key] += add[key] ?? 0;
    } else {
      const total = _shapeToBase(current) + _shapeToBase(add);
      Object.assign(current, _normalizeShape(crucible.api.documents.CrucibleActor.allocateCurrency(total)));
    }
    await _setCurrency(groupActor, current);
    return current;
  });
}

/**
 * Subtract a shaped amount from the pool. In shaped mode the subtraction is
 * per-denomination and fails (returns null) if any denomination is
 * insufficient. In shapeless mode the amounts are summed and compared
 * against the pool's base-unit total.
 * @param {Actor} groupActor
 * @param {Record<string, number>} amounts  per-denomination counts to remove
 * @returns {Promise<Record<string, number>|null>} the new pool, or null if insufficient
 */
export async function _subtractCurrency(groupActor, amounts) {
  const sub = _normalizeShape(amounts);
  return _withStashLock(groupActor.id, async () => {
    const current = _getCurrency(groupActor);
    if (_isShapedCurrency()) {
      for (const key of Object.keys(current)) {
        if (current[key] < (sub[key] ?? 0)) return null;
      }
      for (const key of Object.keys(current)) current[key] -= (sub[key] ?? 0);
    } else {
      const total = _shapeToBase(current) - _shapeToBase(sub);
      if (total < 0) return null;
      Object.assign(current, _normalizeShape(crucible.api.documents.CrucibleActor.allocateCurrency(total)));
    }
    await _setCurrency(groupActor, current);
    return current;
  });
}

/**
 * Format a shaped pool/amount for display. Shaped mode shows each
 * denomination as stored (omitting zeros); shapeless mode shows the greedy
 * allocation of the base-unit total.
 * @param {Record<string, number>|number} amount  shaped object or base-unit total
 * @returns {string}
 */
export function _formatCurrency(amount) {
  const cfg = crucible?.CONFIG?.currency;
  if (!cfg) return String(amount);
  const shape = (typeof amount === "object" && amount !== null)
    ? _normalizeShape(amount)
    : _normalizeShape(crucible.api.documents.CrucibleActor.allocateCurrency(Math.max(Math.trunc(amount), 0)));
  const parts = [];
  for (const [key, denom] of Object.entries(cfg).toSorted((a, b) => b[1].multiplier - a[1].multiplier)) {
    const count = shape[key] ?? 0;
    if (count) parts.push(`${count}${game.i18n.localize(denom.abbreviation)}`);
  }
  return parts.join(" ") || "0";
}

/**
 * Resolve the group actor's member list to an array of Actor instances.
 * Crucible's group member schema uses `actorId` as the reference field;
 * `memberArray.actors` is a runtime Set of resolved Actor instances
 * (populated by the system), falling back to raw array iteration.
 * @param {Actor} groupActor
 * @returns {Actor[]}
 */
export function _resolveGroupMembers(groupActor) {
  const memberArray = groupActor.system.members ?? [];
  if (memberArray.actors) {
    return Array.from(memberArray.actors);
  }
  return Array.from(memberArray)
    .map(m => game.actors.get(m.actorId ?? m.id))
    .filter(Boolean);
}