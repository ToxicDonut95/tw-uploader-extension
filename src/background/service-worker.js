import '../shared/constants.js';
import * as api from './api.js';
import * as queue from './queue.js';

const TD = globalThis.TD;
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
    return { response: null, error: 'Kies een server' };
  }
  if (!world || !playerName) {
    return { response: null, error: 'Vul wereld en spelersnaam in' };
  }

  const result = await api.requestAccess(serverUrl, world, playerName, message.token);
  if (result.error || !result.response) {
    return { response: null, error: result.error || 'Aanvraag mislukt' };
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
    return { response: null, error: 'Kon account niet opslaan' };
  }
  return { response: account, error: null };
}

async function handleVerifyAccount(message) {
  const { accounts, account } = await findAccountByAccessId(message.accessId);
  if (!account) {
    return { response: null, error: 'Account niet gevonden' };
  }

  const result = await api.verifyAccess(account.accessId, account.verifyToken, account.token);
  if (result.error || !result.response) {
    return { response: null, error: result.error || 'Verificatie mislukt' };
  }

  const verifyData = result.response;
  if (verifyData.status === TD.AccessStatus.Verified) {
    account.status = TD.AccountStatus.Verified;
    account.playerId = verifyData.playerId;
    account.playerName = verifyData.playerName;
    account.token = verifyData.sessionToken || account.token;
    account.tokenExpiresAt = verifyData.expiresAt;
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
    return { response: null, error: 'Aanvraag verlopen. Vraag een nieuwe code aan.' };
  }

  return { response: null, error: 'Nog niet geverifieerd. Plak de code in je persoonlijke tekst op je profiel en probeer opnieuw.' };
}

async function handleReRequestAccess(message) {
  const { account } = await findAccountByAccessId(message.accessId);
  if (!account) {
    return { response: null, error: 'Account niet gevonden' };
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
    return { response: null, error: result.error || 'Kon serverlijst niet ophalen' };
  }

  await queue.writeStorage(TD.StorageKeys.Servers, { fetchedAt: Date.now(), servers: result.response });
  return { response: result.response, error: null };
}

async function handleMessage(message) {
  if (!message || typeof message.type !== 'number') {
    return { accepted: false, response: null, error: 'Onbekend berichttype' };
  }
  if (message.type === TD.MessageType.Upload) return handleUpload(message);
  if (message.type === TD.MessageType.RequestAccess) return handleRequestAccess(message);
  if (message.type === TD.MessageType.VerifyAccount) return handleVerifyAccount(message);
  if (message.type === TD.MessageType.ReRequestAccess) return handleReRequestAccess(message);
  if (message.type === TD.MessageType.GetServers) return handleGetServers();
  if (message.type === TD.MessageType.FlushQueue) {
    scheduleFlush();
    return { response: true, error: null };
  }
  return { accepted: false, response: null, error: 'Onbekend berichttype' };
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
