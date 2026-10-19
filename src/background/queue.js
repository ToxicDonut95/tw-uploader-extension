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

let queueLock = Promise.resolve();

function withQueue(mutator) {
  const run = queueLock.then(async function () {
    const items = await readStorage(TD.StorageKeys.Queue, []);
    const outcome = await mutator(items);
    if (outcome && outcome.changed === false) {
      return outcome;
    }
    const saved = await writeStorage(TD.StorageKeys.Queue, items);
    return Object.assign({ saved }, outcome || {});
  });
  queueLock = run.catch(function () {
  });
  return run;
}

function updateItem(itemId, changes) {
  return withQueue(function (items) {
    const item = items.find(function (candidate) {
      return candidate.id === itemId;
    });
    if (!item) {
      return { changed: false };
    }
    Object.assign(item, changes);
    return { changed: true, item: Object.assign({}, item) };
  });
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

  const id = extractItemId(envelope, elementId);
  const hash = buildHash(envelope);

  const outcome = await withQueue(function (items) {
    const duplicate = items.find(function (item) {
      return item.id === id || item.hash === hash;
    });
    if (duplicate) {
      return { changed: false, duplicate: true };
    }

    dropForCapacity(items);

    for (const item of items) {
      if (item.status === TD.UploadStatus.Done && item.envelope) {
        item.envelope = null;
      }
    }

    items.push({
      id,
      hash,
      script: envelope.script,
      serverUrl: envelope.serverUrl,
      world: envelope.world,
      playerId: envelope.playerId,
      playerName: envelope.playerName || '',
      envelope,
      attempts: 0,
      nextAttemptAt: 0,
      status: TD.UploadStatus.Pending,
      error: null,
      createdAt: Date.now()
    });
    return { changed: true };
  });

  if (outcome.duplicate) {
    return { accepted: true, error: null };
  }
  if (!outcome.saved) {
    return { accepted: false, error: text('errorQueueSave') };
  }
  await updateBadge();
  return { accepted: true, error: null };
}

export async function resetNoAccountItems(serverUrl, world, playerId) {
  const outcome = await withQueue(function (items) {
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
    return { changed };
  });
  if (outcome.changed) {
    await updateBadge();
  }
  return outcome.changed === true;
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
let flushRequested = false;

export async function flush() {
  if (flushing) {
    flushRequested = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushRequested = false;
      await flushOnce();
    } while (flushRequested);
  } finally {
    flushing = false;
  }
}

async function flushOnce() {
  const settings = await readStorage(TD.StorageKeys.Settings, {});
  if (settings && settings.autoUploadEnabled === false) return;

  const accounts = await readStorage(TD.StorageKeys.Accounts, []);
  const now = Date.now();
  let accountsChanged = false;

  const snapshot = await withQueue(function (items) {
    for (const item of items) {
      if (item.status === TD.UploadStatus.Uploading) {
        item.status = TD.UploadStatus.Pending;
      }
    }
    return {
      changed: true,
      dueItems: items
        .filter(function (item) {
          return item.status === TD.UploadStatus.Pending && !(item.nextAttemptAt && item.nextAttemptAt > now);
        })
        .map(function (item) {
          return Object.assign({}, item);
        })
    };
  });

  for (const item of snapshot.dueItems) {
    const account = findVerifiedAccount(accounts, item.serverUrl, item.world, item.playerId);
    if (!account) {
      const error = text('errorNoVerifiedAccount');
      await updateItem(item.id, { status: TD.UploadStatus.NoAccount, error });
      await appendLog({ timestamp: Date.now(), script: item.script, serverUrl: item.serverUrl, world: item.world, playerId: item.playerId, playerName: item.playerName || item.envelope?.playerName || '', status: TD.UploadStatus.NoAccount, error });
      continue;
    }

    await updateItem(item.id, { status: TD.UploadStatus.Uploading });

    const result = await api.uploadEnvelope(item.envelope, account.token);
    const changes = {};

    if (result.status === 201) {
      changes.status = TD.UploadStatus.Done;
      changes.error = null;
      changes.envelope = null;
    } else if (result.status === 401) {
      account.status = TD.AccountStatus.Expired;
      accountsChanged = true;
      changes.status = TD.UploadStatus.NoAccount;
      changes.nextAttemptAt = 0;
      changes.error = text('errorSessionExpired');
    } else if (result.status === 403) {
      account.status = TD.AccountStatus.Expired;
      accountsChanged = true;
      changes.status = TD.UploadStatus.NoAccount;
      changes.error = text('errorTokenInvalid');
    } else if (result.status >= 400 && result.status < 500) {
      changes.status = TD.UploadStatus.Failed;
      changes.error = result.error || text('errorUploadRejected');
    } else {
      const attempts = (item.attempts || 0) + 1;
      changes.attempts = attempts;
      if (attempts > TD.BackoffMs.length) {
        changes.status = TD.UploadStatus.Failed;
        changes.error = result.error || text('errorUploadGaveUp');
      } else {
        changes.status = TD.UploadStatus.Pending;
        changes.nextAttemptAt = Date.now() + TD.BackoffMs[attempts - 1];
        changes.error = result.error || text('errorTemporary');
      }
    }

    await updateItem(item.id, changes);

    if (changes.status !== TD.UploadStatus.Pending) {
      await appendLog({ timestamp: Date.now(), script: item.script, serverUrl: item.serverUrl, world: item.world, playerId: item.playerId, playerName: item.playerName || item.envelope?.playerName || '', status: changes.status, error: changes.error });
    }
  }

  if (accountsChanged) {
    await writeStorage(TD.StorageKeys.Accounts, accounts);
  }
  await updateBadge();
}
