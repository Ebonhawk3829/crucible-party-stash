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