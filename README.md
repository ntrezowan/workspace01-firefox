# Workspace01 for Firefox

Single-window workspace manager for Firefox. Organize live tabs into named workspaces and switch between them without closing, recreating, or reloading tabs.

Successor to [Workflow01](https://github.com/ntrezowan/workflow01). Chrome version: [workspace01-chrome](https://github.com/ntrezowan/workspace01-chrome).

## Interface

- Native-looking popup using system colors, light and dark.
- Toolbar icon becomes a two-letter monogram of the current workspace; tooltip shows the full name.
- Rows show name and tab count. Hover a row for hibernate, rename, and delete.
- Drag rows to reorder.
- `+` reveals the create form. `Enter` creates, `Esc` hides it.
- Arrow keys highlight a workspace, `Enter` switches.
- Count pill outlined = hibernated.

## Behavior

- First workspace adopts the currently visible non-pinned tabs.
- Later workspaces open one blank tab and do not steal tabs.
- Switching only hides and shows tabs. Nothing is closed, recreated, discarded, or reloaded.
- Deleting a workspace closes its tabs.
- Hibernate unloads a hidden workspace's tabs from memory (`tabs.discard`). They reload on first use after switching back.
- Reset shows every hidden tab and clears the workspace list. Tabs are kept.
- Pinned tabs are global. Firefox does not let extensions hide pinned tabs.
- Each tab's workspace is stored on the tab with `sessions.setTabValue`, so ownership survives restart and session restore.

## Migrating from Workflow01

Workspace01 is a separate add-on with its own storage and its own per-tab key. Before removing Workflow01: open it, click **Reset all workspaces** so every tab is visible again, then remove it. Install Workspace01 and recreate your workspaces. Firefox also un-hides all tabs automatically when the add-on that hid them is disabled or removed.

## Local testing

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json`.
3. If Firefox asks to allow hidden tabs, choose **Allow**.
4. After editing files, click **Reload** on the add-on card.
5. Background errors: **Inspect** on the add-on card. Popup errors: **Inspect** → the popup document appears in the debugger target list while it is open.

Temporary add-ons are removed when Firefox closes. For a persistent local install, load the signed `.xpi` from AMO, or run `web-ext run` from the project folder.

## Permissions

| Permission | Why |
| ---------- | --- |
| `tabs` | Read and manage tabs for workspace assignment and switching. |
| `tabHide` | Hide and show workspace tabs without closing or recreating them. |
| `storage` | Store workspace names, order, and active workspace locally. |
| `sessions` | Store each tab's workspace id on the tab so ownership survives session restore. |

No data leaves the browser. See [PRIVACY.md](PRIVACY.md).

## License

MIT
