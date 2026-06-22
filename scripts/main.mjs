const MODULE_ID = "crucible-party-stash";
const TEMPLATE_STASH = `modules/${MODULE_ID}/templates/stash-panel.hbs`;

/* ─── Stash Mutex ───
 * Serializes stash mutations to prevent races from concurrent setFlag calls
 * (double-click, overlapping async operations).
 */
let _stashLock = Promise.resolve();

function _withStashLock(fn) {
  _stashLock = _stashLock.then(fn, fn);
  return _stashLock;
}

/* ─── Utilities ─── */

function _readStash(groupActor) {
  return groupActor.getFlag(MODULE_ID, "stash") ?? [];
}

function _getStash(groupActor) {
  return foundry.utils.deepClone(_readStash(groupActor));
}

async function _setStash(groupActor, stash) {
  await groupActor.setFlag(MODULE_ID, "stash", stash);
}

function _checkStashCapacity(stash) {
  const max = game.settings.get(MODULE_ID, "stashCapacity");
  return { ok: max === 0 || stash.length < max, max };
}

/**
 * Whether the current user meets the minimum role to see and use the stash.
 * GMs always pass.
 * @returns {boolean}
 */
function canUseStash() {
  if (game.user.isGM) return true;
  const minRole = game.settings.get(MODULE_ID, "minRole");
  return game.user.role >= minRole;
}

/* ─── Initialization ─── */

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

/* ─── Render the stash panel HTML ─── */

async function _renderStashHTML(items, isEditable) {
  try {
    return await foundry.applications.handlebars.renderTemplate(
      TEMPLATE_STASH,
      { items, isEmpty: items.length === 0, isEditable }
    );
  } catch (err) {
    console.error(`${MODULE_ID} | Template render failed`, err);
    return `<div class="stash-empty">
      <p><i class="fa-solid fa-exclamation-triangle"></i> ${game.i18n.localize("CRUCIBLE_PARTY_STASH.TemplateError")}</p>
    </div>`;
  }
}

/* ─── Core Injection ───
 *
 * CrucibleGroupActorSheet uses root: true on its single PARTS entry, so Foundry
 * places children directly inside .window-content rather than a .sheet-body wrapper.
 * We target .window-content accordingly. */

Hooks.on("renderCrucibleGroupActorSheet", async (app, element, context, options) => {
  const actor = app.actor;
  if (!actor || actor.type !== "group") return;

  // ── permission gate ──
  if (!canUseStash()) return;

  const windowContent = element.querySelector(".window-content");
  if (!windowContent) return;

  const isEditable = app.isEditable;
  const stashItems = _getStash(actor);
  const activeTab = app._stashActiveTab || "members";

  // Build tab bar
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

  // Capture original sheet children into the members panel
  const originalChildren = Array.from(windowContent.childNodes);

  const membersTab = document.createElement("div");
  membersTab.className = `party-stash-panel ${activeTab === "members" ? "active" : ""}`;
  membersTab.dataset.stashTab = "members";
  for (const child of originalChildren) {
    membersTab.appendChild(child);
  }

  // Stash tab
  const stashTab = document.createElement("div");
  stashTab.className = `party-stash-panel ${activeTab === "stash" ? "active" : ""}`;
  stashTab.dataset.stashTab = "stash";
  stashTab.innerHTML = await _renderStashHTML(stashItems, isEditable);

  windowContent.innerHTML = "";
  windowContent.appendChild(tabBar);
  windowContent.appendChild(membersTab);
  windowContent.appendChild(stashTab);

  // ─── Tab switching ───
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

  // ─── Stash listeners ───
  _activateStashDropListeners(stashTab, actor);
  _activateStashActionListeners(stashTab, actor);
});

/* ─── Hero/Adversary sheet: intercept stash drops ─── */

Hooks.on("renderActorSheetV2", (app, element) => {
  if (app.actor?.type === "hero" || app.actor?.type === "adversary") {
    _setupHeroDropInterception(app, element);
  }
});

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
    ev.stopPropagation(); // Prevent the sheet's own drop handler from firing
    stashTab.classList.remove("drag-over");

    let data;
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
    if (data.type !== "Item" || data.fromStash) return;

    const item = await Item.implementation.fromDropData(data);
    if (!item) return;

    // Early capacity check (optimization — avoids dialog if full)
    if (!_checkStashCapacity(_readStash(groupActor)).ok) {
      ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: game.settings.get(MODULE_ID, "stashCapacity") }));
      return;
    }

    const src = item.parent;
    let shouldDelete = false;

    if (src instanceof Actor && src.id !== groupActor.id) {
      if (game.settings.get(MODULE_ID, "confirmTransfer")) {
        try {
          shouldDelete = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize("CRUCIBLE_PARTY_STASH.MoveToStash") },
            content: `<p>${game.i18n.format("CRUCIBLE_PARTY_STASH.MoveConfirm", { name: item.name, actor: src.name })}</p>`,
            yes: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Move"), icon: "fa-solid fa-box-open" },
            no: { label: game.i18n.localize("CRUCIBLE_PARTY_STASH.CopyOnly"), icon: "fa-solid fa-copy" }
          });
        } catch { return; }
      } else {
        shouldDelete = true;
      }
      if (shouldDelete) {
        await src.deleteEmbeddedDocuments("Item", [item.id]);
      }
    }

    // Mutate stash under lock to prevent races with concurrent remove/give
    const name = await _withStashLock(async () => {
      const s = _getStash(groupActor);
      const cap = _checkStashCapacity(s);
      if (!cap.ok) {
        ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: cap.max }));
        return null;
      }
      const itemData = item.toObject();
      itemData._stashId = foundry.utils.randomID();
      s.push(itemData);
      const sheet = groupActor.sheet;
      if (sheet) sheet._stashActiveTab = "stash";
      await _setStash(groupActor, s);
      return item.name;
    });
    if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemAdded", { name }));
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
    const index = Number(el.dataset.index);

    if (action === "remove") {
      const removed = await _withStashLock(async () => {
        const s = _getStash(groupActor);
        const [item] = s.splice(index, 1);
        const sheet = groupActor.sheet;
        if (sheet) sheet._stashActiveTab = "stash";
        await _setStash(groupActor, s);
        return item;
      });
      ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemRemoved", { name: removed?.name ?? "Unknown" }));
      return;
    }

    if (action === "give") {
      const memberArray = groupActor.system.members ?? [];

      // Crucible attaches an `actors` Set of resolved Actor instances on the members array
      const actors = memberArray.actors
        ? Array.from(memberArray.actors)
        : Array.from(memberArray).map(m => game.actors.get(m.actorId ?? m.id ?? m._id)).filter(Boolean);

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

      const name = await _transferFromStash(groupActor, index, target);
      if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemGiven", { name, target: target.name }));
    }
  });

  // Drag items OUT of the stash
  stashTab.addEventListener("dragstart", (ev) => {
    // Don't let control buttons (give/remove) trigger a drag
    if (ev.target.closest("[data-stash-action]")) {
      ev.preventDefault();
      return;
    }
    const li = ev.target.closest(".stash-item[data-index]");
    if (!li) return;
    const index = Number(li.dataset.index);
    const stash = _readStash(groupActor);
    const itemData = stash[index];
    if (!itemData) return;
    ev.dataTransfer.setData("text/plain", JSON.stringify({
      type: "Item",
      data: itemData,
      fromStash: true,
      stashIndex: index,
      groupActorId: groupActor.id
    }));
  });
}

/* ─── Transfer: stash → character ─── */

async function _transferFromStash(groupActor, stashIndex, targetActor) {
  return _withStashLock(async () => {
    const stash = _getStash(groupActor);
    const itemData = stash[stashIndex];
    if (!itemData) return null;

    const cleanData = foundry.utils.deepClone(itemData);
    delete cleanData._id;
    delete cleanData._stashId;

    const created = await targetActor.createEmbeddedDocuments("Item", [cleanData]);
    if (!created.length) return null;

    stash.splice(stashIndex, 1);
    const sheet = groupActor.sheet;
    if (sheet) sheet._stashActiveTab = "stash";
    await _setStash(groupActor, stash);

    return itemData.name;
  });
}

/* ─── Recipient picker dialog ─── */

async function _pickRecipient(choices) {
  const field = new foundry.data.fields.StringField({
    label: game.i18n.localize("CRUCIBLE_PARTY_STASH.Recipient"),
    choices,
    required: true,
    blank: false
  });

  const wrapper = document.createElement("div");
  wrapper.className = "stash-dialog-content";
  wrapper.append(field.toFormGroup({}, { name: "recipient" }));
  const contentHTML = wrapper.outerHTML;

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
          const form = button.closest("form") ?? button.closest(".window-content");
          const select = form?.querySelector("select[name=recipient]");
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

/* ─── Stash → character (V1 dropActorSheetData hook) ─── */

Hooks.on("dropActorSheetData", async (targetActor, sheet, data) => {
  if (!data?.fromStash || data.groupActorId === targetActor.id) return;
  const groupActor = game.actors.get(data.groupActorId);
  if (!groupActor) return;
  const name = await _transferFromStash(groupActor, data.stashIndex, targetActor);
  if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemMovedTo", { name, target: targetActor.name }));
});

/* ─── Stash → V2 hero sheet (direct drop interception) ─── */

function _setupHeroDropInterception(app, element) {
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

    const groupActor = game.actors.get(data.groupActorId);
    if (!groupActor) return;

    const name = await _transferFromStash(groupActor, data.stashIndex, app.actor);
    if (name) ui.notifications.info(game.i18n.format("CRUCIBLE_PARTY_STASH.ItemMovedTo", { name, target: app.actor.name }));
  }, true);
}

/* ─── Ready ─── */

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready. FVTT ${game.version}, Crucible ${game.system?.version}`);
});