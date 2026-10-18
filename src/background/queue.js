import '../shared/constants.js';
import '../shared/i18n.js';
import * as api from './api.js';

const TD = globalThis.TD;
const text = globalThis.tdText;

export async function readStorage(key, fallback) {
  try {
    const stored = await chrome.storage.local.get(key);
    if (stored && Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== undefined) {
      return stored[key];
    }
    return fallback;
  } catch (storageError) {
    return fallback;
  }
}

export async function writeStorage(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch (storageError) {
    return false;
  }
}

function buildHash(envelope) {
  return [envelope.serverUrl, envelope.world, envelope.playerId, envelope.script, envelope.exportedAt].join('|');
}

export function normalizeServerUrl(serverUrl) {
  if (typeof serverUrl !== 'string') return '';
  const trimmed = serverUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch (urlError) {
    return trimmed.toLowerCase();
  }
}

export function serverMatches(serverUrl, originUrl) {
  const serverHost = hostOf(serverUrl);
  const originHost = hostOf(originUrl);
  if (!serverHost || !originHost) return false;
  if (serverHost === originHost) return true;

  return coversHost(serverHost, originHost) || coversHost(originHost, serverHost);
}

function coversHost(host, marketHost) {
  const domain = marketHost.startsWith('www.') ? marketHost.slice(4) : marketHost;
  return host === domain || host.endsWith('.' + domain);
}

function hostOf(url) {
  const normalized = normalizeServerUrl(url);
  if (!normalized) return '';
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch (urlError) {
    return '';
  }
}

function extractItemId(envelope, elementId) {
  const prefix = 'td-upload-' + envelope.script + '-';
  if (typeof elementId === 'string' && elementId.startsWith(prefix) && elementId.length > prefix.length) {
    return elementId.slice(prefix.length);
  }
  try {
    return crypto.randomUUID();
  } catch (uuidError) {
    return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  }
}

function dropForCapacity(items) {
  const removable = [TD.UploadStatus.Done, TD.UploadStatus.Failed];
  while (items.length >= TD.MaxQueueItems) {
    let dropIndex = -1;
    for (const status of removable) {
      let oldestAt = Infinity;
      for (let i = 0; i < items.length; i++) {
        if (items[i].status === status && items[i].createdAt < oldestAt) {
          oldestAt = items[i].createdAt;
          dropIndex = i;
        }
      }
      if (dropIndex !== -1) break;
    }
    if (dropIndex === -1) {
      let oldestAt = Infinity;
      for (let i = 0; i < items.length; i++) {
        if (items[i].createdAt < oldestAt) {
          oldestAt = items[i].createdAt;
          dropIndex = i;
        }
      }
    }
    if (dropIndex === -1) break;
    items.splice(dropIndex, 1);
  }
}

export async function appendLog(entry) {
  const log = await readStorage(TD.StorageKeys.Log, []);
  log.push(entry);
  while (log.length > TD.MaxLogItems) {
    log.shift();
  }
  await writeStorage(TD.StorageKeys.Log, log);
}

export async function updateBadge() {
  const items = await readStorage(TD.StorageKeys.Queue, []);
  const count = items.filter(function (item) {
    return item.status === TD.UploadStatus.Failed || item.status === TD.UploadStatus.NoAccount;
  }).length;
  try {
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
    }
  } catch (badgeError) {
  }
}

export async function enqueue(envelope, elementId) {
  if (!envelope || typeof envelope !== 'object') {
    return { accepted: false, error: text('errorInvalidEnvelope') };
  }
  if (!envelope.script || !envelope.world || envelope.playerId === undefined || envelope.playerId === null) {
    return { accepted: false, error: text('errorEnvelopeMissingFields') };
  }
  if (!normalizeServerUrl(envelope.serverUrl)) {
    return { accepted: false, error: text('errorEnvelopeMissingServer') };
  }

  const items = await readStorage(TD.StorageKeys.Queue, []);
  const id = extractItemId(envelope, elementId);
  const hash = buildHash(envelope);

  const duplicate = items.find(function (item) {
    return item.id === id || item.hash === hash;
  });
  if (duplicate) {
    return { accepted: true, error: null };
  }

  dropForCapacity(items);

  items.push({
    id,
    hash,
    script: envelope.script,
    serverUrl: envelope.serverUrl,
    world: envelope.world,
    playerId: envelope.playerId,
    envelope,
    attempts: 0,
    nextAttemptAt: 0,
    status: TD.UploadStatus.Pending,
    error: null,
    createdAt: Date.now()
  });

  const saved = await writeStorage(TD.StorageKeys.Queue, items);
  if (!saved) {
    return { accepted: false, error: text('errorQueueSave') };
  }
  await updateBadge();
  return { accepted: true, error: null };
}

export async function resetNoAccountItems(serverUrl, world, playerId) {
  const items = await readStorage(TD.StorageKeys.Queue, []);
  let changed = false;
  for (const item of items) {
    if (item.status !== TD.UploadStatus.NoAccount) continue;
    if (!serverMatches(item.serverUrl, serverUrl)) continue;
    if (item.world !== world) continue;
    if (String(item.playerId) !== String(playerId)) continue;
    item.status = TD.UploadStatus.Pending;
    item.attempts = 0;
    item.nextAttemptAt = 0;
    item.error = null;
    changed = true;
  }
  if (changed) {
    await writeStorage(TD.StorageKeys.Queue, items);
    await updateBadge();
  }
  return changed;
}

function findVerifiedAccount(accounts, serverUrl, world, playerId) {
  return accounts.find(function (account) {
    return account.status === TD.AccountStatus.Verified &&
      serverMatches(account.serverUrl, serverUrl) &&
      account.world === world &&
      String(account.playerId) === String(playerId) &&
      account.token;
  });
}

let flushing = false;

export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const settings = await readStorage(TD.StorageKeys.Settings, {});
    if (settings && settings.autoUploadEnabled === false) return;

    const items = await readStorage(TD.StorageKeys.Queue, []);
    const accounts = await readStorage(TD.StorageKeys.Accounts, []);
    const now = Date.now();
    let queueChanged = false;
    let accountsChanged = false;

    for (const item of items) {
      if (item.status === TD.UploadStatus.Uploading) {
        item.status = TD.UploadStatus.Pending;
        queueChanged = true;
      }
    }

    for (const item of items) {
      if (item.status !== TD.UploadStatus.Pending) continue;
      if (item.nextAttemptAt && item.nextAttemptAt > now) continue;

      const account = findVerifiedAccount(accounts, item.serverUrl, item.world, item.playerId);
      if (!account) {
        item.status = TD.UploadStatus.NoAccount;
        item.error = text('errorNoVerifiedAccount');
        queueChanged = true;
        await appendLog({ timestamp: Date.now(), script: item.script, serverUrl: item.serverUrl, world: item.world, status: item.status, error: item.error });
        continue;
      }

      item.status = TD.UploadStatus.Uploading;
      await writeStorage(TD.StorageKeys.Queue, items);

      const result = await api.uploadEnvelope(item.envelope, account.token);
      queueChanged = true;

      if (result.status === 201) {
        item.status = TD.UploadStatus.Done;
        item.error = null;
      } else if (result.status === 401) {
        account.status = TD.AccountStatus.Expired;
        accountsChanged = true;
        item.status = TD.UploadStatus.NoAccount;
        item.nextAttemptAt = 0;
        item.error = text('errorSessionExpired');
      } else if (result.status === 403) {
        account.status = TD.AccountStatus.Expired;
        accountsChanged = true;
        item.status = TD.UploadStatus.NoAccount;
        item.error = text('errorTokenInvalid');
      } else if (result.status >= 400 && result.status < 500) {
        item.status = TD.UploadStatus.Failed;
        item.error = result.error || text('errorUploadRejected');
      } else {
        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts > TD.BackoffMs.length) {
          item.status = TD.UploadStatus.Failed;
          item.error = result.error || text('errorUploadGaveUp');
        } else {
          item.status = TD.UploadStatus.Pending;
          item.nextAttemptAt = Date.now() + TD.BackoffMs[item.attempts - 1];
          item.error = result.error || text('errorTemporary');
          continue;
        }
      }

      await appendLog({ timestamp: Date.now(), script: item.script, serverUrl: item.serverUrl, world: item.world, status: item.status, error: item.error });
    }

    if (queueChanged) {
      await writeStorage(TD.StorageKeys.Queue, items);
    }
    if (accountsChanged) {
      await writeStorage(TD.StorageKeys.Accounts, accounts);
    }
    if (queueChanged) {
      await updateBadge();
    }
  } finally {
    flushing = false;
  }
}
