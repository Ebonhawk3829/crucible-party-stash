# Crucible Party Stash

A module for [Foundry VTT](https://foundryvtt.com/)'s **Crucible** system (V14+) that adds a shared party inventory tab to the Group actor sheet.

## Features

- **Shared stash tab** — Injects a "Shared Stash" tab into the Crucible Group Actor Sheet alongside the existing Members content.
- **Drag & drop** — Drag items from any character sheet directly into the party stash. Drag items from the stash back onto a character sheet to retrieve them.
- **Give items** — Click the "Give" icon on any stashed item to pick a party member and transfer it directly.
- **Capacity limit** — Optionally cap the number of items the stash can hold (configurable in module settings, 0 = unlimited).
- **Multi-sheet support** — Works with both V1 and V2 (ApplicationV2) character sheets via `dropActorSheetData` hook and direct DOM event interception.

## Installation

1. Copy this folder to `{userData}/Data/modules/crucible-party-stash/`
2. Enable the module in your Foundry world: **Manage Modules** → **Crucible Party Stash**
3. Open any Group actor sheet — you'll see a "Shared Stash" tab alongside the "Members" tab.

## Usage

### Adding items to the stash
- **Drag** an item from a hero/adversary sheet onto the Shared Stash tab.
- A confirmation dialog will ask whether to **Move** (delete from source) or **Copy** (keep the original).
- The item appears in the shared stash list.

### Removing items from the stash
- **Drag** a stash item directly onto any character sheet — it will be created on that actor and removed from the stash.
- Click the **Give** icon (hand-holding) on a stash item to pick a specific party member as the recipient.
- Click the **Trash** icon to delete the item from the stash permanently.

## Module Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Stash Capacity Limit | 0 (unlimited) | Maximum items the party stash can hold |
| Confirm item transfers | Yes | Show a confirmation dialog when moving items |

## Data Storage

Items are stored as a **flag** (`crucible-party-stash.stash`) on the Group actor document. This avoids relying on Crucible's embedded document system, since Group actors have no inventory data model and `createEmbeddedDocuments("Item")` may not work reliably on them.

## Compatibility

- **Foundry VTT:** Version 14 (minimum)
- **Crucible System:** Version 0.10.0+ (Alpha)
- This module is restricted to Crucible system worlds only.

## Development

### Structure
```
crucible-party-stash/
├── module.json             # Module manifest
├── scripts/
│   └── main.mjs            # Core module logic
├── styles/
│   └── party-stash.css     # Tab and stash styling
├── templates/
│   └── stash-panel.hbs     # Handlebars template for the stash tab
├── lang/
│   └── en.json             # English localizations
├── .gitignore
└── README.md
```

### Building
No build step required — this is a plain ES module module. Run `foundryvtt` and test with `CONFIG.debug.hooks = true` in the browser console to verify hook firing.

## License

MIT