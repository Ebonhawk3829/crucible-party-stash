---
title: Shared Party Inventory for the Crucible Game System
description: A shared party inventory and loot management module for Crucible in Foundry Virtual Tabletop. Pool items, distribute loot, and manage a shared stash on the Group Actor sheet.
---

# Crucible Party Stash — Shared Party Inventory for Foundry VTT

![Foundry v14](https://img.shields.io/badge/Foundry-v14-informational)
![Crucible](https://img.shields.io/badge/System-Crucible-orange)
![Latest Release](https://img.shields.io/github/v/release/Ebonhawk3829/crucible-party-stash?label=Latest)
![License](https://img.shields.io/github/license/Ebonhawk3829/crucible-party-stash)

**Crucible Party Stash** is a free, open-source **shared party inventory** module for the [Crucible game system](https://foundryvtt.com/packages/crucible) in [Foundry Virtual Tabletop (Foundry VTT)](https://foundryvtt.com/). It adds a dedicated **Stash** tab to the Crucible Group Actor sheet so your players can pool items, distribute loot, and manage shared party resources — all without leaving the group sheet.

If you've been searching for a way to handle **party loot, shared treasure, or a communal inventory in Crucible on Foundry VTT**, this module gives your table a single shared stash that every player can deposit into and withdraw from.

![Screenshot of the Crucible Party Stash shared inventory tab on the Foundry VTT Group Actor sheet](docs/screenshot-stash-tab.png)

## Why use a shared party stash?

Not every item your party owns belongs on an individual character sheet. Crucible Party Stash gives you a shared, off-sheet pool for the gear that the group collectively hauls around — think a pack animal, a cart, or a big sack of out-of-combat supplies.

Use it for things like:

- Food, water, and camping supplies
- Rope, tools, and other utility gear that rarely comes up mid-combat
- Loot you're carrying to sell back in town
- A reserve of potions and consumables that don't fit on a character's belt

The stash keeps these items organized in one place and out of the way, while still letting any player deposit or withdraw with a drag-and-drop or the give button — so the gear is there when you actually need it, without cluttering up everyone's inventory.

## Features

- **Shared Stash Tab** — A new tab on the Crucible Group Actor sheet for pooling party items alongside the existing Members tab.
- **Drag & Drop Loot Management** — Drag items from any character sheet into the shared stash, or drag them back out to a character.
- **Split on Deposit** — When stashing a stacked item (e.g. 5 Healing Potions), choose how many to deposit. The source keeps the remainder.
- **Split on Withdrawal** — When giving or dragging a stashed stack to a character, choose how many to take. The remainder stays in the stash.
- **Auto-Merge Stacks** — Stashing an item that matches an existing entry (same type, affixes, quality) increments the existing quantity instead of creating a duplicate.
- **Give to Character** — Click the give button to hand an item directly to any party member via a dropdown picker.
- **Capacity Limit** — Set a maximum number of stash slots (0 = unlimited). Merged entries reuse existing slots.
- **Role-Based Access** — Configure the minimum user role required to see and use the shared inventory. GMs always have access.
- **Quantity Display** — Shows item quantities for stackable Crucible items.

## Installation

### Install from Foundry VTT

1. Open Foundry VTT and go to **Add-on Modules** → **Install Module**.
2. Paste the following URL into the **Manifest URL** field:
`https://github.com/Ebonhawk3829/crucible-party-stash/releases/latest/download/module.json`
3. Click **Install**.
4. Enable the module in your world.

### Manual Installation

Download `module.zip` from the [latest release](https://github.com/Ebonhawk3829/crucible-party-stash/releases/latest), extract it into your `Data/modules/` directory, and restart Foundry VTT.

## Requirements

| Requirement | Version |
|---|---|
| Foundry VTT | v14+ |
| Crucible | 0.10.0+ |

This module **only** works with the Crucible game system. It hooks into `CrucibleGroupActorSheet` and will not activate for other systems.

## Settings

All settings are world-scoped and configurable by the GM under **Settings** → **Module Settings** → **Crucible Party Stash**.

| Setting | Default | Description |
|---|---|---|
| Stash Capacity | 0 (unlimited) | Maximum number of stash slots. Merged entries reuse existing slots. Set to 0 for no limit. |
| Confirm Transfer | Enabled | For single items, show a confirmation dialog when moving to the stash. For stacks, a quantity prompt is always shown regardless of this setting. |
| Minimum Role | Player | The minimum user role required to see and interact with the stash tab. |

## How to use the shared stash

1. **Open a Group Actor sheet** — the module adds a tab bar with **Members** and **Stash** tabs.
2. **Add items** — Drag an item from any Hero or Adversary character sheet onto the Stash tab. For stacked items (qty > 1), a dialog lets you choose how many to stash.
3. **Retrieve items** — Either drag an item from the stash onto a character sheet, or click the give button and pick a party member from the list. For stacked items, a dialog lets you choose how many to take.
4. **Auto-merge** — Stashing an item that matches an existing entry (same affixes, quality, etc.) automatically increments the existing quantity.
5. **Remove items** — Click the trash icon to delete an item from the stash entirely.

## Compatibility

This module targets Crucible's `CrucibleGroupActorSheet` and uses Foundry V14 APIs including `ApplicationV2`, `DialogV2`, `NumberField` settings, and Handlebars template rendering under the `foundry.applications.handlebars` namespace.

It is designed to be non-destructive — stash data is stored as a flag on the Group Actor (`crucible-party-stash.stash`) and does not modify any core Crucible data models.

### Known Interactions

- **Ember** — Compatible. The module does not interfere with Ember's adventure content or Vista engine. Stash data persists independently of adventure imports.