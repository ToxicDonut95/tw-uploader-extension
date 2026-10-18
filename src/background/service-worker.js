import '../shared/constants.js';
import '../shared/i18n.js';
import * as api from './api.js';
import * as queue from './queue.js';

const TD = globalThis.TD;
const text = globalThis.tdText;
const FLUSH_ALARM = 'td-flush';

function scheduleFlush() {
  queue.flush().catch(function () {});
}

function ensureAlarm() {
  try {
    chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  } catch (alarmError) {
  }
}

chrome.runtime.onInstalled.addListener(function () {
  ensureAlarm();
  scheduleFlush();
});

chrome.runtime.onStartup.addListener(function () {
  ensureAlarm();
  scheduleFlush();
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === FLUSH_ALARM) {
    scheduleFlush();
  }
});

ensureAlarm();
queue.updateBadge().catch(function () {});

async function findAccountByAccessId(accessId) {
  const accounts = await queue.readStorage(TD.StorageKeys.Accounts, []);
  const account = accounts.find(function (candidate) {
    return candidate.accessId === accessId;
  });
  return { accounts, account };
}

async function handleUpload(message) {
  const envelope = message.envelope && typeof message.envelope === 'object' ? message.envelope : null;
  if (envelope && !envelope.serverUrl && message.origin) {
    envelope.serverUrl = message.origin;
  }

  const settings = await queue.readStorage(TD.StorageKeys.Settings, {});
  if (settings && settings.autoUploadEnabled === false) {
    return { accepted: false, paused: true, error: null };
  }

  const result = await queue.enqueue(envelope, message.elementId);
  if (result.accepted) {
    scheduleFlush();
  }
  return result;
}

async function handleRequestAccess(message) {
  const serverUrl = queue.normalizeServerUrl(message.serverUrl);
  const world = typeof message.world === 'string' ? message.world.trim() : '';
  const playerName = typeof message.playerName === 'string' ? message.playerName.trim() : '';
  if (!serverUrl) {
    return { response: null, error: text('errorChooseServer') };
  }
  if (!world || !playerName) {
    return { response: null, error: text('errorWorldAndPlayer') };
  }

  const result = await api.requestAccess(serverUrl, world, playerName, message.token);
  if (result.error || !result.response) {
    return { response: null, error: result.error || text('errorRequestFailed') };
  }

  const accessData = result.response;
  const accounts = await queue.readStorage(TD.StorageKeys.Accounts, []);
  let account = accounts.find(function (candidate) {
    return queue.serverMatches(candidate.serverUrl, serverUrl) &&
      candidate.world === accessData.world &&
      String(candidate.playerId) === String(accessData.playerId);
  });
  if (!account) {
    account = {
      serverUrl: accessData.serverUrl || serverUrl,
      serverName: accessData.serverName || '',
      world: accessData.world,
      playerId: accessData.playerId,
      playerName: accessData.playerName,
      accessId: null,
      verifyToken: null,
      status: TD.AccountStatus.Unverified,
      token: null,
      tokenExpiresAt: null,
      readKey: null,
      verifiedAt: null
    };
    accounts.push(account);
  }
  account.serverUrl = accessData.serverUrl || serverUrl;
  account.serverName = accessData.serverName || account.serverName || '';
  account.playerName = accessData.playerName;
  account.playerId = accessData.playerId;
  account.accessId = accessData.id;
  account.verifyToken = accessData.verifyToken;
  account.status = TD.AccountStatus.PendingVerification;
  account.token = accessData.sessionToken || null;
  account.tokenExpiresAt = null;

  const saved = await queue.writeStorage(TD.StorageKeys.Accounts, accounts);
  if (!saved) {
    return { response: null, error: text('errorSaveAccount') };
  }
  return { response: account, error: null };
}

async function handleVerifyAccount(message) {
  const { accounts, account } = await findAccountByAccessId(message.accessId);
  if (!account) {
    return { response: null, error: text('errorAccountNotFound') };
  }

  const result = await api.verifyAccess(account.accessId, account.verifyToken, account.token);
  if (result.error || !result.response) {
    return { response: null, error: result.error || text('errorVerifyFailed') };
  }

  const verifyData = result.response;
  if (verifyData.status === TD.AccessStatus.Verified) {
    account.status = TD.AccountStatus.Verified;
    account.playerId = verifyData.playerId;
    account.playerName = verifyData.playerName;
    account.token = verifyData.sessionToken || account.token;
    account.tokenExpiresAt = verifyData.expiresAt || null;
    account.readKey = verifyData.readKey || account.readKey || null;
    account.verifiedAt = new Date().toISOString();
    account.serverUrl = verifyData.serverUrl || account.serverUrl;
    account.serverName = verifyData.serverName || account.serverName || '';
    await queue.writeStorage(TD.StorageKeys.Accounts, accounts);
    await queue.resetNoAccountItems(account.serverUrl, account.world, account.playerId);
    scheduleFlush();
    return { response: account, error: null };
  }

  if (verifyData.status === TD.AccessStatus.Expired) {
    account.status = TD.AccountStatus.Expired;
    await queue.writeStorage(TD.StorageKeys.Accounts, accounts);
    return { response: null, error: text('errorRequestExpired') };
  }

  return { response: null, error: text('errorNotVerifiedYet') };
}

async function handleReRequestAccess(message) {
  const { account } = await findAccountByAccessId(message.accessId);
  if (!account) {
    return { response: null, error: text('errorAccountNotFound') };
  }
  return handleRequestAccess({ serverUrl: account.serverUrl, world: account.world, playerName: account.playerName, token: account.token });
}

async function handleGetServers() {
  const cached = await queue.readStorage(TD.StorageKeys.Servers, null);
  if (cached && Array.isArray(cached.servers) && cached.servers.length > 0 && Date.now() - cached.fetchedAt < TD.ServersCacheMs) {
    return { response: cached.servers, error: null };
  }

  const result = await api.getServers();
  if (result.error || !Array.isArray(result.response)) {
    if (cached && Array.isArray(cached.servers) && cached.servers.length > 0) {
      return { response: cached.servers, error: null };
    }
    return { response: null, error: result.error || text('errorServersFailed') };
  }

  await queue.writeStorage(TD.StorageKeys.Servers, { fetchedAt: Date.now(), servers: result.response });
  return { response: result.response, error: null };
}

async function handleGetWorlds(message) {
  const serverUrl = queue.normalizeServerUrl(message.serverUrl);
  if (!serverUrl) {
    return { response: null, error: text('errorChooseServer') };
  }

  const result = await api.getWorlds(serverUrl);
  if (result.error || !Array.isArray(result.response)) {
    return { response: null, error: result.error || text('errorWorldsFailed') };
  }
  return { response: result.response, error: null };
}

async function handleRemoveAccount(message) {
  const { accounts, account } = await findAccountByAccessId(message.accessId);
  if (!account) {
    return { response: null, error: text('errorAccountNotFound') };
  }

  if (account.token) {
    const result = await api.removeAccess(account.accessId, account.token);
    if (result.error && result.status !== 401 && result.status !== 404) {
      return { response: null, error: result.error || text('errorRemoveFailed') };
    }
  }

  const remaining = accounts.filter(function (candidate) {
    return candidate !== account;
  });
  const saved = await queue.writeStorage(TD.StorageKeys.Accounts, remaining);
  if (!saved) {
    return { response: null, error: text('errorRemoveFailed') };
  }
  return { response: true, error: null };
}

async function handleMessage(message) {
  if (!message || typeof message.type !== 'number') {
    return { accepted: false, response: null, error: text('errorUnknownMessage') };
  }
  if (message.type === TD.MessageType.Upload) return handleUpload(message);
  if (message.type === TD.MessageType.RequestAccess) return handleRequestAccess(message);
  if (message.type === TD.MessageType.VerifyAccount) return handleVerifyAccount(message);
  if (message.type === TD.MessageType.ReRequestAccess) return handleReRequestAccess(message);
  if (message.type === TD.MessageType.GetServers) return handleGetServers();
  if (message.type === TD.MessageType.GetWorlds) return handleGetWorlds(message);
  if (message.type === TD.MessageType.RemoveAccount) return handleRemoveAccount(message);
  if (message.type === TD.MessageType.FlushQueue) {
    scheduleFlush();
    return { response: true, error: null };
  }
  return { accepted: false, response: null, error: text('errorUnknownMessage') };
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  handleMessage(message)
    .then(sendResponse)
    .catch(function (unexpectedError) {
      const errorMessage = unexpectedError && unexpectedError.message ? unexpectedError.message : String(unexpectedError);
      sendResponse({ accepted: false, response: null, error: errorMessage });
    });
  return true;
});
