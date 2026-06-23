/* ─── Crucible Party Stash ───────────────────────────────────────
 * Entry point: settings, template loading, hook registrations,
 * and the global game.tooltip.deactivate monkey-patch.
 *
 * Delegates to:
 *   stash-data.mjs    — flag read/write, locking, capacity, stackability
 *   stash-tooltip.mjs — rich item-card tooltips + fallback renderer
 *   stash-transfer.mjs — stash↔hero transfer workflows + drop intercepts
 *   stash-ui.mjs      — DOM construction, tab injection, event wiring
 * ──────────────────────────────────────────────────────────────── */

import { MODULE_ID, _getStash, canUseStash } from "./stash-data.mjs";
import { stashTooltip, onExternalDeactivate } from "./stash-tooltip.mjs";
import { _setupHeroDropInterception, onDropActorSheetData } from "./stash-transfer.mjs";
import {
  TEMPLATE_STASH, _renderStashHTML, _activateStashDropListeners, _activateStashActionListeners
} from "./stash-ui.mjs";

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
  stashTooltip.clearCache();

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

  stashTooltip.bind(stashTab, actor);
});

Hooks.on("renderActorSheetV2", (app, element) => {
  if (app.actor?.type === "hero" || app.actor?.type === "adversary") {
    _setupHeroDropInterception(app, element);
  }
});

Hooks.on("dropActorSheetData", onDropActorSheetData);

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready. FVTT ${game.version}, Crucible ${game.system?.version}`);

  // MONKEY-PATCH: TooltipManager has no deactivation hook as of v14.364.
  // The tooltip module owns its state cleanup (onExternalDeactivate);
  // this entry point owns the global mutation so it's auditable in one place.
  const _origDeactivate = game.tooltip.deactivate.bind(game.tooltip);
  game.tooltip.deactivate = function (...args) {
    onExternalDeactivate();
    return _origDeactivate(...args);
  };
});