/* ─── Stash Tooltip Subsystem ────────────────────────────────────
 * On hover, builds a temporary in-memory CrucibleItem from the serialised
 * stash data and calls renderCard(). Uses game.tooltip.activate() directly
 * to avoid synthetic event re-dispatch and data-tooltip-html attribute races.
 *
 * Fallback: if renderCard() fails (e.g. item type that requires actor context),
 * shows the item name + icon instead of nothing.
 *
 * The entry point (main.mjs) is responsible for the global
 * game.tooltip.deactivate monkey-patch; this module exports
 * onExternalDeactivate() so the patch can clean up our state
 * without reaching into our internals.
 * ──────────────────────────────────────────────────────────────── */

import { MODULE_ID, _readStash } from "./stash-data.mjs";

const _TOOLTIP_CACHE_MAX = 50;

export const stashTooltip = {
  _activeId: null,
  _ourTooltipActive: false,
  _deactivateTimeout: null,
  _cache: new Map(),

  /**
   * Bind tooltip listeners to each .stash-tooltip-zone element.
   * The zone excludes the .controls div, so Foundry's data-tooltip tooltips
   * on control buttons never compete with the rich item-card tooltip.
   * Called once per render from the renderCrucibleGroupActorSheet hook.
   * @param {HTMLElement} stashTab
   * @param {Actor} groupActor
   */
  bind(stashTab, groupActor) {
    const zones = stashTab.querySelectorAll(".stash-item .stash-tooltip-zone");
    for (const zone of zones) {
      const li = zone.closest(".stash-item[data-stash-id]");
      if (!li) continue;
      zone.addEventListener("pointerenter", (ev) => this._onItemEnter(ev, li, groupActor));
      zone.addEventListener("pointerleave", (ev) => this._onItemLeave(ev, li));
    }
  },

  _onItemEnter(ev, li, groupActor) {
    const stashId = li.dataset.stashId;

    if (this._activeId === stashId) {
      clearTimeout(this._deactivateTimeout);
      this._deactivateTimeout = null;
      // Recover if Foundry (or another module) killed our tooltip.
      if (!this._ourTooltipActive) {
        this._showTooltip(li, stashId, groupActor);
      }
      return;
    }

    if (this._activeId) {
      clearTimeout(this._deactivateTimeout);
      this._deactivateTimeout = null;
      this._ourTooltipActive = false;
      this._activeId = null;
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
        this._ourTooltipActive = false;
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
        this._ourTooltipActive = true;
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
    this._ourTooltipActive = true;
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
    this._ourTooltipActive = true;
  }
};

/**
 * Called by the entry point's game.tooltip.deactivate monkey-patch.
 * Clears our internal tracking so we don't think our tooltip is still
 * active after Foundry (or another module) has deactivated it.
 */
export function onExternalDeactivate() {
  if (stashTooltip._ourTooltipActive) {
    stashTooltip._ourTooltipActive = false;
    stashTooltip._activeId = null;
  }
}