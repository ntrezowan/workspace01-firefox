'use strict';

// Workspace01 — Firefox background (event page)
//
// Firefox owns tab lifetime. Workspace01 owns only workspace labels and tab
// visibility. Switching hides and shows tabs; it never closes, recreates, or
// reloads them. Each tab's workspace id is stored on the tab with
// sessions.setTabValue so ownership survives session restore.
//
// Workspace state (names, order, active id) is global. Hiding/showing is done
// per window, for whichever window the popup was opened from.

const STORAGE_KEY = 'workspace01';
const SCHEMA_VERSION = 1;
const TAB_KEY = 'workspace01.workspaceId';
const NAME_MAX = 40;
const ICON_GREY = '#8e8e93';
const ICON_SIZES = [16, 32, 48];
const DEFAULT_ICON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' };

const emptyState = () => ({ schemaVersion: SCHEMA_VERSION, workspaces: [], activeId: null });

// ---------- serialization: one mutation at a time ----------

let chain = Promise.resolve();
let busy = false;
function serialized(fn) {
  const run = chain.then(async () => {
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  });
  chain = run.catch(() => {});
  return run;
}

// ---------- state ----------

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  const state = Object.assign(emptyState(), raw);
  state.schemaVersion = SCHEMA_VERSION;
  if (!Array.isArray(state.workspaces)) state.workspaces = [];
  state.workspaces = state.workspaces.filter((w) => w && typeof w.id === 'string' && typeof w.name === 'string');
  for (const w of state.workspaces) if (!Number.isInteger(w.activeTabId)) w.activeTabId = null;
  if (state.activeId && !state.workspaces.some((w) => w.id === state.activeId)) {
    state.activeId = state.workspaces[0] ? state.workspaces[0].id : null;
  }
  return state;
}

async function loadState() {
  const data = await browser.storage.local.get(STORAGE_KEY);
  return migrate(data[STORAGE_KEY]);
}

async function saveState(state) {
  await browser.storage.local.set({ [STORAGE_KEY]: state });
}

// ---------- helpers ----------

const findWorkspace = (state, id) => state.workspaces.find((w) => w.id === id) || null;
const ownable = (tab) => tab && tab.id !== undefined && !tab.pinned;

function normalizeName(state, raw, ignoreId = null) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Enter a workspace name.');
  if (name.length > NAME_MAX) throw new Error(`Keep the name under ${NAME_MAX} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('The name contains invalid characters.');
  if (!/[\p{L}\p{N}]/u.test(name)) throw new Error('Use at least one letter or number.');
  const clash = state.workspaces.find((w) => w.id !== ignoreId && w.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`"${clash.name}" already exists.`);
  return name;
}

async function queryTabs(q) {
  try {
    return await browser.tabs.query(q);
  } catch {
    return [];
  }
}

async function getTabWs(tabId) {
  try {
    const id = await browser.sessions.getTabValue(tabId, TAB_KEY);
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}
async function setTabWs(tabId, wsId) {
  try {
    await browser.sessions.setTabValue(tabId, TAB_KEY, wsId);
  } catch {}
}
async function clearTabWs(tabId) {
  try {
    await browser.sessions.removeTabValue(tabId, TAB_KEY);
  } catch {}
}

// Ownership map for one window: wsId -> tabs[], plus tabs with no owner.
async function mapWindow(windowId) {
  const owned = new Map();
  const unowned = [];
  for (const tab of await queryTabs({ windowId })) {
    if (!ownable(tab)) continue;
    const id = await getTabWs(tab.id);
    if (id) {
      if (!owned.has(id)) owned.set(id, []);
      owned.get(id).push(tab);
    } else {
      unowned.push(tab);
    }
  }
  return { owned, unowned };
}

async function resolveWindow(preferredId) {
  if (Number.isInteger(preferredId)) {
    try {
      const w = await browser.windows.get(preferredId);
      if (w.type === 'normal' && !w.incognito) return w.id;
    } catch {}
  }
  const wins = await browser.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  const w = wins.find((c) => c.focused && !c.incognito) || wins.find((c) => !c.incognito);
  return w ? w.id : null;
}

// ---------- toolbar icon: two-letter monogram of the current workspace ----------

function monogramImage(text, size) {
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(size, size) : document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = ICON_GREY;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const px = Math.round(size * (text.length > 1 ? 0.6 : 0.78));
  ctx.font = `700 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.fillText(text, size / 2, size / 2 + size * 0.04);
  return ctx.getImageData(0, 0, size, size);
}

async function updateIcon(state) {
  const ws = findWorkspace(state, state.activeId);
  await browser.action.setBadgeText({ text: '' }).catch(() => {});
  await browser.action.setTitle({ title: ws ? `Workspace01 – ${ws.name}` : 'Workspace01' }).catch(() => {});
  if (!ws) {
    await browser.action.setIcon({ path: DEFAULT_ICON }).catch(() => {});
    return;
  }
  const text = ws.name.replace(/\s+/g, '').slice(0, 2).toUpperCase() || ws.name.slice(0, 1);
  try {
    const imageData = {};
    for (const size of ICON_SIZES) imageData[size] = monogramImage(text, size);
    await browser.action.setIcon({ imageData });
  } catch (e) {
    console.warn('Workspace01: monogram icon failed, falling back to badge', e);
    await browser.action.setBadgeText({ text }).catch(() => {});
    await browser.action.setBadgeBackgroundColor({ color: ICON_GREY }).catch(() => {});
  }
}

// ---------- visibility ----------

// Make `wsId` the visible workspace in `windowId`: show its tabs, make sure it
// has at least one, activate one, then hide every other known workspace's tabs.
async function applyWorkspace(state, windowId, wsId) {
  const ws = findWorkspace(state, wsId);
  if (!ws) return;
  const { owned } = await mapWindow(windowId);
  let mine = owned.get(wsId) || [];

  if (mine.length) {
    await browser.tabs.show(mine.map((t) => t.id)).catch(() => {});
  } else {
    const tab = await browser.tabs.create({ windowId, active: true });
    await setTabWs(tab.id, wsId);
    mine = [tab];
  }

  const focus = mine.find((t) => t.id === ws.activeTabId) || mine.find((t) => t.active) || mine[0];
  await browser.tabs.update(focus.id, { active: true }).catch(() => {});

  const known = new Set(state.workspaces.map((w) => w.id));
  const toHide = [];
  for (const [id, tabs] of owned) {
    if (id === wsId || !known.has(id)) continue;
    for (const t of tabs) if (!t.hidden) toHide.push(t.id);
  }
  if (toHide.length) await browser.tabs.hide(toHide).catch(() => {});
}

async function rememberActiveTab(state, windowId) {
  const ws = findWorkspace(state, state.activeId);
  if (!ws) return;
  const active = (await queryTabs({ windowId, active: true }))[0];
  ws.activeTabId = active && ownable(active) && (await getTabWs(active.id)) === ws.id ? active.id : null;
}

// ---------- view for the popup ----------

async function buildView(state, windowId) {
  const win = await resolveWindow(windowId);
  const { owned } = win == null ? { owned: new Map() } : await mapWindow(win);
  const workspaces = state.workspaces.map((ws) => {
    const tabs = owned.get(ws.id) || [];
    const active = ws.id === state.activeId;
    return {
      id: ws.id,
      name: ws.name,
      active,
      live: true,
      count: tabs.length,
      hibernated: !active && tabs.length > 0 && tabs.every((t) => t.discarded)
    };
  });
  return { workspaces, activeId: state.activeId };
}

// ---------- operations ----------

async function switchTo(state, targetId, preferredWindow) {
  if (!findWorkspace(state, targetId)) throw new Error('That workspace no longer exists.');
  const windowId = await resolveWindow(preferredWindow);
  if (windowId == null) throw new Error('No browser window to switch in.');
  if (targetId === state.activeId) {
    await applyWorkspace(state, windowId, targetId);
    return;
  }
  await rememberActiveTab(state, windowId);
  state.activeId = targetId;
  await saveState(state);
  await applyWorkspace(state, windowId, targetId);
  await updateIcon(state);
}

async function createWorkspace(state, rawName, preferredWindow) {
  const name = normalizeName(state, rawName);
  const windowId = await resolveWindow(preferredWindow);
  if (windowId == null) throw new Error('No browser window to create in.');
  const ws = { id: crypto.randomUUID(), name, createdAt: Date.now(), updatedAt: Date.now(), activeTabId: null };
  const isFirst = state.workspaces.length === 0;
  await rememberActiveTab(state, windowId);
  state.workspaces.push(ws);
  state.activeId = ws.id;
  await saveState(state);

  if (isFirst) {
    // Adopt the visible, unowned, non-pinned tabs of this window.
    const { unowned } = await mapWindow(windowId);
    const visible = unowned.filter((t) => !t.hidden);
    for (const t of visible) await setTabWs(t.id, ws.id);
  } else {
    const tab = await browser.tabs.create({ windowId, active: true });
    await setTabWs(tab.id, ws.id);
  }
  await applyWorkspace(state, windowId, ws.id);
  await updateIcon(state);
}

async function renameWorkspace(state, id, rawName) {
  const ws = findWorkspace(state, id);
  if (!ws) throw new Error('That workspace no longer exists.');
  ws.name = normalizeName(state, rawName, id);
  ws.updatedAt = Date.now();
  await saveState(state);
  await updateIcon(state);
}

async function reorderWorkspaces(state, ids) {
  const byId = new Map(state.workspaces.map((w) => [w.id, w]));
  const ordered = [];
  for (const id of ids) {
    const w = byId.get(id);
    if (w) {
      ordered.push(w);
      byId.delete(id);
    }
  }
  state.workspaces = [...ordered, ...byId.values()];
  await saveState(state);
}

// Delete closes the workspace's tabs in every window.
async function deleteWorkspace(state, id, preferredWindow) {
  const ws = findWorkspace(state, id);
  if (!ws) throw new Error('That workspace no longer exists.');
  const windowId = await resolveWindow(preferredWindow);

  const ownedIds = [];
  for (const tab of await queryTabs({})) {
    if (ownable(tab) && (await getTabWs(tab.id)) === id) ownedIds.push(tab.id);
  }

  if (id === state.activeId) {
    const next = state.workspaces.find((w) => w.id !== id);
    if (next) {
      state.activeId = next.id;
      await saveState(state);
      if (windowId != null) await applyWorkspace(state, windowId, next.id);
    } else if (windowId != null) {
      // Last workspace: leave a blank tab so the window survives.
      await browser.tabs.create({ windowId, active: true }).catch(() => {});
      state.activeId = null;
    }
  }

  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  await saveState(state);
  for (const tabId of ownedIds) await clearTabWs(tabId);
  if (ownedIds.length) await browser.tabs.remove(ownedIds).catch(() => {});
  await updateIcon(state);
}

// Hibernate unloads a hidden workspace's tabs from memory (tabs.discard).
async function hibernateWorkspace(state, id, preferredWindow) {
  if (id === state.activeId) throw new Error('Switch away before hibernating this workspace.');
  if (!findWorkspace(state, id)) throw new Error('That workspace no longer exists.');
  const windowId = await resolveWindow(preferredWindow);
  if (windowId == null) throw new Error('No browser window.');
  const { owned } = await mapWindow(windowId);
  const ids = (owned.get(id) || []).filter((t) => !t.active && !t.discarded).map((t) => t.id);
  if (!ids.length) throw new Error('Nothing to hibernate in this workspace.');
  await browser.tabs.discard(ids);
}

// Reset shows every hidden tab, drops all ownership, and clears the list.
async function resetAll() {
  for (const tab of await queryTabs({})) {
    if (!ownable(tab)) continue;
    await clearTabWs(tab.id);
    if (tab.hidden) await browser.tabs.show(tab.id).catch(() => {});
  }
  const fresh = emptyState();
  await saveState(fresh);
  await updateIcon(fresh);
}

// ---------- listeners ----------

// New tabs join the active workspace. Skipped while a mutation is running, so
// tabs created by switch/create keep the owner we set explicitly.
browser.tabs.onCreated.addListener((tab) => {
  if (busy || !ownable(tab)) return;
  serialized(async () => {
    if (await getTabWs(tab.id)) return;
    const state = await loadState();
    if (state.activeId) await setTabWs(tab.id, state.activeId);
  });
});

// Pinning makes a tab global; unpinning returns it to the active workspace.
browser.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    serialized(async () => {
      if (changeInfo.pinned) {
        await clearTabWs(tabId);
      } else {
        const state = await loadState();
        if (state.activeId) await setTabWs(tabId, state.activeId);
      }
    });
  },
  { properties: ['pinned'] }
);

async function bootstrap() {
  const state = await loadState();
  await updateIcon(state);
  if (!state.activeId) return;
  for (const win of await browser.windows.getAll({ windowTypes: ['normal'] }).catch(() => [])) {
    if (win.incognito) continue;
    await applyWorkspace(state, win.id, state.activeId);
  }
}
browser.runtime.onStartup.addListener(() => serialized(bootstrap));
browser.runtime.onInstalled.addListener(() => serialized(bootstrap));

// ---------- messages ----------

async function handle(msg) {
  const state = await loadState();
  const win = Number.isInteger(msg.windowId) ? msg.windowId : null;
  switch (msg.type) {
    case 'getView':
      await updateIcon(state);
      break;
    case 'create':
      await createWorkspace(state, msg.name, win);
      break;
    case 'switch':
      await switchTo(state, msg.id, win);
      break;
    case 'rename':
      await renameWorkspace(state, msg.id, msg.name);
      break;
    case 'reorder':
      await reorderWorkspaces(state, msg.ids || []);
      break;
    case 'delete':
      await deleteWorkspace(state, msg.id, win);
      break;
    case 'hibernate':
      await hibernateWorkspace(state, msg.id, win);
      break;
    case 'resetAll':
      await resetAll();
      break;
    default:
      throw new Error(`Unknown request: ${msg.type}`);
  }
  return buildView(await loadState(), win);
}

browser.runtime.onMessage.addListener((msg) =>
  serialized(() => handle(msg || {})).then(
    (view) => ({ ok: true, view }),
    (err) => ({ ok: false, error: err && err.message ? err.message : String(err) })
  )
);
