import '../shared/constants.js';

async function postJson(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }
  let response;
  try {
    response = await fetch(globalThis.TD.API_BASE + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  } catch (networkError) {
    return { status: 0, response: null, error: 'Netwerkfout: ' + (networkError && networkError.message ? networkError.message : String(networkError)) };
  }

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

export function requestAccess(playerName, world) {
  return postJson('/api/v1.0/portal/access/request', { playerName, world });
}

export function verifyAccess(accessId, verifyToken) {
  return postJson('/api/v1.0/portal/access/verify', { accessId, verifyToken });
}

export function uploadEnvelope(envelope, token) {
  return postJson('/api/v1.0/portal/upload', envelope, token);
}
