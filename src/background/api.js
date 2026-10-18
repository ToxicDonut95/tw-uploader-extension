import '../shared/constants.js';
import '../shared/i18n.js';

function requestHeaders(token, withBody) {
  const headers = { [globalThis.TD.CLIENT_HEADER]: globalThis.TD.CLIENT_NAME };
  if (withBody) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }
  return headers;
}

async function readResponse(response) {
  let text = '';
  let parsed = null;
  try {
    text = await response.text();
  } catch (readError) {
    text = '';
  }
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      parsed = null;
    }
  }

  if (response.ok) {
    return { status: response.status, response: parsed, error: null };
  }

  const message = parsed && parsed.message ? parsed.message : (text || 'HTTP ' + response.status);
  return { status: response.status, response: parsed, error: message };
}

async function send(path, method, body, token) {
  let response;
  try {
    response = await fetch(globalThis.TD.API_BASE + path, {
      method,
      credentials: 'omit',
      headers: requestHeaders(token, body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (networkError) {
    return { status: 0, response: null, error: globalThis.tdText('errorNetwork', [networkError && networkError.message ? networkError.message : String(networkError)]) };
  }

  return readResponse(response);
}

export function getServers() {
  return send('/api/v1.0/portal/servers', 'GET');
}

export function getWorlds(serverUrl) {
  return send('/api/v1.0/portal/worlds?serverUrl=' + encodeURIComponent(serverUrl), 'GET');
}

export function requestAccess(serverUrl, world, playerName, token) {
  return send('/api/v1.0/portal/access/request', 'POST', { serverUrl, world, playerName }, token);
}

export function verifyAccess(accessId, verifyToken, token) {
  return send('/api/v1.0/portal/access/verify', 'POST', { accessId, verifyToken }, token);
}

export function removeAccess(accessId, token) {
  return send('/api/v1.0/portal/access/' + encodeURIComponent(accessId), 'DELETE', undefined, token);
}

export function uploadEnvelope(envelope, token) {
  return send('/api/v1.0/portal/upload', 'POST', envelope, token);
}
