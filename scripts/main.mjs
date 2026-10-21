/* ─── Crucible Party Stash ───────────────────────────────────────
 * Entry point: settings, template loading, hook registrations,
 * and the global game.tooltip.deactivate monkey-patch.
 *
 * Delegates to:
 *   stash-data.mjs    — flag read/write, locking, capacity, stackability
 *   stash-tooltip.mjs — rich item-card tooltips + fallback renderer
 *   stash-transfer.mjs — stash↔hero transfer workflows + drop intercepts
 *   stash-ui.mjs      — stash context builder + event wiring
 * ──────────────────────────────────────────────────────────────── */

import { MODULE_ID, canUseStash, _log, _runPendingStashMigrations } from "./stash-data.mjs";
import { stashTooltip, onExternalDeactivate } from "./stash-tooltip.mjs";
import { _setupHeroDropInterception, onDropActorSheetData } from "./stash-transfer.mjs";
import {
  TEMPLATE_STASH, _prepareStashContext, _activateStashDropListeners, _activateStashActionListeners
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

  game.settings.register(MODULE_ID, "shapedCurrency", {
    name: "CRUCIBLE_PARTY_STASH.ShapedCurrency",
    hint: "CRUCIBLE_PARTY_STASH.ShapedCurrencyHint",
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

  game.settings.register(MODULE_ID, "debugLogging", {
    name: "CRUCIBLE_PARTY_STASH.DebugLogging",
    hint: "CRUCIBLE_PARTY_STASH.DebugLoggingHint",
    scope: "client", config: true, type: Boolean, default: false
  });

  // Bookkeeping for one-shot stash migrations. World-scoped so every client
  // agrees on what has run, and hidden from the settings UI — it is internal
  // state, not a user preference. Each entry is a migration id; see
  // STASH_MIGRATIONS in stash-data.mjs.
  game.settings.register(MODULE_ID, "completedMigrations", {
    scope: "world", config: false, type: Array, default: []
  });

  await foundry.applications.handlebars.loadTemplates([TEMPLATE_STASH]);
});

// Patched after `init` so Crucible has finished exposing its API, and before
// `ready` so no group sheet has rendered yet.
Hooks.once("setup", () => _registerGroupSheetStashTab());

/* ─── Native Tab Integration ───
 *
 * Crucible 0.11.2 rebuilt CrucibleGroupActorSheet as a set of template parts
 * with its own tab group (Members / Milestones). Rather than injecting our own
 * tab bar and moving the sheet's DOM around, we register the Shared Stash as a
 * first-class part and tab of that sheet:
 *
 *   - a `stash` template part renders templates/stash-panel.hbs
 *   - a `stash` entry in TABS.sheet adds the navigation button
 *
 * The system's own tab navigation and ApplicationV2#changeTab then handle
 * showing and hiding the panel, so the stash tab coexists with Members and
 * Milestones instead of competing with them. */

function _registerGroupSheetStashTab() {
  const sheetClass = crucible?.api?.applications?.CrucibleGroupActorSheet;
  if (!sheetClass) {
    console.error(`${MODULE_ID} | CrucibleGroupActorSheet not found — the Shared Stash tab is unavailable.`);
    return;
  }

  sheetClass.PARTS.stash = {
    template: TEMPLATE_STASH,
    scrollable: [".stash-scroll"]
  };
  sheetClass.TABS.sheet.tabs.push({ id: "stash", icon: "fa-solid fa-box-open" });

  // Remember the tab the user selects so it survives a re-render. Crucible
  // forces the Members tab for groups that do not track advancement (it renders
  // no tab navigation for those), which would otherwise yank the user back to
  // Members on every stash update.
  const changeTab = sheetClass.prototype.changeTab;
  sheetClass.prototype.changeTab = function (tab, group, options) {
    const result = changeTab.call(this, tab, group, options);
    if (group === "sheet") this._stashPreferredTab = tab;
    return result;
  };

  // Supply the stash context to the part, and hide the tab entirely when the
  // acting user does not meet the configured minimum role.
  const prepareContext = sheetClass.prototype._prepareContext;
  sheetClass.prototype._prepareContext = async function (options) {
    const context = await prepareContext.call(this, options);
    if (!canUseStash() || this.actor?.type !== "group") {
      if (context.tabs) delete context.tabs.stash;
      return context;
    }
    const preferred = this._stashPreferredTab;
    if (preferred && this.tabGroups.sheet !== preferred) {
      this.tabGroups.sheet = preferred;
      context.tabs = this._prepareTabs("sheet");
    }
    Object.assign(context, _prepareStashContext(this.actor, this.isEditable));
    return context;
  };

  // Drop the part (not just the nav entry) when the user cannot use the stash,
  // and fall back to Members if a previous session left Stash selected.
  const configureRenderParts = sheetClass.prototype._configureRenderParts;
  sheetClass.prototype._configureRenderParts = function (options) {
    const parts = configureRenderParts.call(this, options);
    if (!canUseStash()) {
      delete parts.stash;
      if (this.tabGroups?.sheet === "stash") this.tabGroups.sheet = "members";
    }
    return parts;
  };
}

/* ─── Fallback Tab Navigation ───
 * Groups that do not track advancement render no tab navigation of their own
 * (Crucible drops the `tabs` part), which would leave the stash unreachable.
 * In that case we add a minimal Members/Stash nav so the tab can be opened. */

function _ensureStashTabNav(app, element) {
  const content = element.querySelector(".window-content");
  if (!content || content.querySelector("nav.tabs")) return;

  const active = app.tabGroups?.sheet ?? "members";
  const nav = document.createElement("nav");
  nav.className = "sheet-tabs tabs";
  nav.setAttribute("aria-roledescription", game.i18n.localize("SHEETS.FormNavLabel"));
  for (const { id, icon, label } of [
    { id: "members", icon: "fa-solid fa-users", label: "ACTOR.GROUP.TABS.members" },
    { id: "stash", icon: "fa-solid fa-box-open", label: "ACTOR.GROUP.TABS.stash" }
  ]) {
    const button = document.createElement("a");
    button.dataset.action = "tab";
    button.dataset.group = "sheet";
    button.dataset.tab = id;
    if (id === active) button.classList.add("active");
    button.innerHTML = `<i class="${icon}" inert></i><span>${game.i18n.localize(label)}</span>`;
    nav.appendChild(button);
  }

  const header = content.querySelector(".group-header");
  if (header) header.after(nav);
  else content.prepend(nav);
}

Hooks.on("renderCrucibleGroupActorSheet", (app, element) => {
  if (app.actor?.type !== "group") return;

  // Stash entries are immutable between flag writes, and any flag write
  // triggers a re-render. Clear the tooltip cache so stale rendered cards
  // from a previous render cycle are never served.
  stashTooltip.clearCache();

  if (!canUseStash()) return;

  const section = element.querySelector('.tab[data-group="sheet"][data-tab="stash"]');
  if (!section) return;

  _ensureStashTabNav(app, element);

  // Re-renders replace the part's DOM, so a fresh element gets fresh listeners.
  // The guard avoids double-binding when the part was not re-rendered.
  if (section.dataset.stashReady) return;
  section.dataset.stashReady = "1";

  _log("renderCrucibleGroupActorSheet", {
    actorId: app.actor.id,
    isEditable: app.isEditable,
    isGM: game.user.isGM,
    role: game.user.role
  });

  _activateStashDropListeners(section, app.actor);
  _activateStashActionListeners(section, app.actor);
  stashTooltip.bind(section, app.actor);
});

Hooks.on("renderActorSheetV2", (app, element) => {
  if (app.actor?.type === "hero" || app.actor?.type === "adversary") {
    _setupHeroDropInterception(app, element);
  }
});

Hooks.on("dropActorSheetData", onDropActorSheetData);

Hooks.once("ready", async () => {
  // Crucible 0.11.0 exposes `crucible.migrating`, a Promise which resolves once
  // the world is known to be at the current system version. A world which needs
  // migration never resolves it — migration always ends in a page reload, so we
  // resume on the next load against fully migrated data instead.
  //
  // We only touch flags on user interaction (drag/drop, transfer), never at
  // ready, so this is belt-and-braces rather than a live bug. It matters because
  // 0.11.0's migration force-resets hero talents and re-syncs every owned
  // equipment item from its compendium source: reading or writing stash flags
  // mid-migration could persist against half-migrated actors.
  const migrating = game.system?.migrating;
  if (migrating instanceof Promise) {
    _log("ready", { awaiting: "crucible.migrating" });
    await migrating;
    _log("ready", { awaiting: "crucible.migrating", resolved: true });
  }

  // One-shot stash migrations. Runs here rather than at `init` because it
  // needs `game.actors` populated, compendium packs indexed, and Crucible's
  // own migration finished — at `init` the upstream data we resync against
  // may still be the pre-update version.
  //
  // Restricted to the active GM so exactly one client writes the flag.
  if (game.users.activeGM?.isSelf) {
    const ran = await _runPendingStashMigrations();
    for (const { id, result } of ran) {
      if (result.error) {
        console.error(`${MODULE_ID} | Migration "${id}" failed: ${result.error}`);
        ui.notifications.error(game.i18n.format("CRUCIBLE_PARTY_STASH.MigrationFailed", { id }));
      } else if (result.updated > 0) {
        ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ResyncComplete", {
          updated: result.updated,
          skipped: result.skipped
        }));
      }
    }
  }

  console.log(`${MODULE_ID} | Ready. FVTT ${game.version}, Crucible ${game.system?.version}`);

  // MONKEY-PATCH: TooltipManager has no deactivation hook as of v14.367.
  // The tooltip module owns its state cleanup (onExternalDeactivate);
  // this entry point owns the global mutation so it's auditable in one place.
  const _origDeactivate = game.tooltip.deactivate.bind(game.tooltip);
  game.tooltip.deactivate = function (...args) {
    onExternalDeactivate();
    return _origDeactivate(...args);
  };
});