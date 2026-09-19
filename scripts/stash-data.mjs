/* ─── Stash Data Layer ───────────────────────────────────────────
 * Pure data access and mutation for the party stash flag.
 * No DOM, no UI, no hooks — just the flag, the lock, and helpers.
 *
 * Every other module in this package imports from here.
 * ──────────────────────────────────────────────────────────────── */

export const MODULE_ID = "crucible-party-stash";

/* ─── Debug logging ───
 * Gated on the client-scoped `debugLogging` setting so it can be toggled
 * live from Module Settings without a reload. Wrapped in try/catch because
 * it may be called before settings are registered or after teardown.
 */
export function _log(...args) {
  try {
    if (!game?.settings?.get(MODULE_ID, "debugLogging")) return;
  } catch { return; }
  console.log(`${MODULE_ID} |`, ...args);
}

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
  _log("_resolveGroupMembers: raw", {
    isArray: Array.isArray(memberArray),
    hasActorsProp: !!memberArray.actors,
    actorsSize: memberArray.actors?.size ?? null,
    length: memberArray.length ?? null,
    raw: memberArray
  });

  let resolved;
  if (memberArray.actors) {
    resolved = Array.from(memberArray.actors);
  } else {
    resolved = Array.from(memberArray)
      .map(m => game.actors.get(m.actorId ?? m.id))
      .filter(Boolean);
  }

  _log("_resolveGroupMembers: resolved", resolved.map(a => ({
    id: a.id,
    name: a.name,
    owner: a.testUserPermission(game.user, "OWNER")
  })));
  return resolved;
}

/* ─── One-Shot Stash Migrations ──────────────────────────────────
 *
 * Named, self-disabling migrations. Each is identified by a string key
 * recorded in the world-scoped `completedMigrations` setting. On load we
 * run every migration whose key is absent, then record it, so each one
 * executes exactly once per world — ever.
 *
 * Why named keys rather than a single version number: a version number
 * can only express "everything before N has run". Named keys let two
 * unrelated migrations coexist, and let a migration added in a later
 * release run on a world that already ran an earlier one.
 *
 * To add a future migration: append an entry to STASH_MIGRATIONS with a
 * new unique id. Never reuse or edit an existing id — a world that has
 * already recorded it will silently skip the new behaviour.
 */

/**
 * The migrations which have been defined, in the order they should run.
 * Each entry is `{id, fn}` where `fn` is async and returns a result object.
 * @type {ReadonlyArray<{id: string, fn: Function}>}
 */
export const STASH_MIGRATIONS = Object.freeze([
  { id: "resync-compendium-0.11.0", fn: _resyncStashFromCompendium }
]);

/**
 * Run any stash migration which this world has not yet recorded.
 * Safe to call on every load; recorded migrations are skipped.
 *
 * Caller must ensure this runs on exactly one client (the active GM) and
 * after `crucible.migrating` has resolved.
 * @returns {Promise<Array<{id: string, result: object}>>} Results for migrations that ran
 */
export async function _runPendingStashMigrations() {
  const completed = new Set(game.settings.get(MODULE_ID, "completedMigrations") ?? []);
  const ran = [];

  for (const { id, fn } of STASH_MIGRATIONS) {
    if (completed.has(id)) {
      _log("migration: skip (already recorded)", { id });
      continue;
    }
    _log("migration: run", { id });
    let result;
    try {
      result = await fn();
    } catch (err) {
      // Record even on failure. A migration that throws every load is worse
      // than one that ran partially; the error is surfaced to the GM and the
      // manual resync button remains available for a retry.
      console.error(`${MODULE_ID} | Migration "${id}" failed:`, err);
      result = { error: err.message };
    }
    completed.add(id);
    await game.settings.set(MODULE_ID, "completedMigrations", Array.from(completed));
    ran.push({ id, result });
  }
  return ran;
}

/**
 * Re-resolve every stash entry against its upstream compendium source.
 *
 * Stash entries are frozen `item.toObject()` snapshots. When Crucible
 * updates an item's upstream data (as 0.11.0 did with a comprehensive
 * copy-edit pass and a forced equipment re-sync), live items on actors
 * update but stash snapshots do not, so the same item can show different
 * name/price/weight depending on where you look at it.
 *
 * Mirrors Crucible's own `_migrateEquipmentItem`: replace `system` from
 * upstream, then restore the fields which are genuinely player state.
 *
 * Entries with no resolvable compendium source (hand-made items) are
 * skipped rather than discarded — we cannot know what they should be.
 * @returns {Promise<{updated: number, skipped: number, unresolved: number, groups: number}>}
 */
export async function _resyncStashFromCompendium() {
  const stats = { updated: 0, skipped: 0, unresolved: 0, groups: 0 };

  // Every group actor in the world, not just the configured party — a world
  // may hold several groups and each carries its own stash flag.
  const groups = game.actors.filter(a => a.type === "group");
  stats.groups = groups.length;

  // Cache resolved upstream documents; many stash entries share a source.
  const upstreamCache = new Map();

  for (const groupActor of groups) {
    const stash = _readStash(groupActor);
    if (!stash.length) continue;

    let changed = false;
    const next = [];

    for (const entry of stash) {
      const upstream = await _resolveUpstream(entry, upstreamCache);

      // No compendium lineage: a hand-made or imported item. Leave it alone.
      if (!upstream) {
        stats.skipped++;
        next.push(entry);
        continue;
      }

      const sourceUuid = entry._stats?.compendiumSource ?? null;
      if (!sourceUuid) {
        stats.unresolved++;
        next.push(entry);
        continue;
      }

      const upstreamSource = upstream.toObject();
      const updated = {
        ...entry,
        name: upstreamSource.name,
        img: upstreamSource.img,
        type: upstreamSource.type,
        system: foundry.utils.deepClone(upstreamSource.system)
      };

      // Restore player state that upstream must not clobber.
      // Mirrors Crucible's stateFields, plus the stash's own bookkeeping.
      const stateFields = [
        ...(upstream.system?.constructor?.STATEFUL_FIELDS ?? []),
        "quantity", "quality", "enchantment", "slot", "loaded", "uses"
      ];
      for (const field of stateFields) {
        const value = entry.system?.[field];
        if (value !== undefined) updated.system[field] = foundry.utils.deepClone(value);
      }
      updated._stashId = entry._stashId;

      // Preserve embedded affix effects, which are player-applied enchantments
      // rather than part of the upstream definition.
      if (entry.effects?.length) updated.effects = foundry.utils.deepClone(entry.effects);

      if (foundry.utils.objectsEqual(entry, updated)) {
        stats.skipped++;
        next.push(entry);
        continue;
      }

      _log("resync: updated", {
        group: groupActor.name,
        before: entry.name,
        after: updated.name
      });
      stats.updated++;
      changed = true;
      next.push(updated);
    }

    if (changed) await _setStash(groupActor, next);
  }

  _log("resync: complete", stats);
  return stats;
}

/**
 * Resolve the upstream compendium document for a stash entry.
 * Prefers the recorded `compendiumSource` UUID, falling back to an
 * identifier search across the configured equipment packs — the same
 * fallback Crucible's own `#getBaseItemName` uses.
 * @param {object} entry                     A stash entry
 * @param {Map<string, object>} cache        Shared resolution cache
 * @returns {Promise<object|null>}
 */
async function _resolveUpstream(entry, cache) {
  const sourceUuid = entry._stats?.compendiumSource;
  if (sourceUuid) {
    if (cache.has(sourceUuid)) return cache.get(sourceUuid);
    const doc = await fromUuid(sourceUuid).catch(() => null);
    cache.set(sourceUuid, doc);
    return doc;
  }

  // Fall back to an identifier search across configured equipment packs.
  const identifier = entry.system?.identifier;
  if (!identifier) return null;
  const cacheKey = `id:${entry.type}:${identifier}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let found = null;
  for (const packId of crucible.CONFIG.packs.equipment ?? []) {
    const pack = game.packs.get(packId);
    if (!pack) continue;
    if (!pack.indexed) await pack.getIndex();
    for (const idx of pack.index.values()) {
      if (idx.type === entry.type && idx.system?.identifier === identifier) {
        found = await pack.getDocument(idx._id).catch(() => null);
        break;
      }
    }
    if (found) break;
  }
  cache.set(cacheKey, found);
  return found;
}