(function () {
  const accountsList = document.getElementById('accounts-list');
  const logList = document.getElementById('log-list');
  const messageBox = document.getElementById('message');
  const autoUploadToggle = document.getElementById('auto-upload-toggle');
  const addForm = document.getElementById('add-account-form');
  const worldInput = document.getElementById('world-input');
  const playerInput = document.getElementById('player-input');
  const serverSelect = document.getElementById('server-select');

  let servers = [];

  function showMessage(text, isInfo) {
    messageBox.textContent = text;
    messageBox.classList.toggle('info', Boolean(isInfo));
    messageBox.hidden = false;
  }

  function clearMessage() {
    messageBox.hidden = true;
    messageBox.textContent = '';
  }

  async function readStorage(key, fallback) {
    try {
      const stored = await chrome.storage.local.get(key);
      if (stored && stored[key] !== undefined) return stored[key];
      return fallback;
    } catch (storageError) {
      return fallback;
    }
  }

  async function writeStorage(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      return true;
    } catch (storageError) {
      return false;
    }
  }

  function sendMessage(payload) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(payload, function (reply) {
          if (chrome.runtime.lastError) {
            resolve({ response: null, error: chrome.runtime.lastError.message || 'Geen verbinding met achtergrondproces' });
            return;
          }
          resolve(reply || { response: null, error: 'Geen antwoord van achtergrondproces' });
        });
      } catch (sendError) {
        resolve({ response: null, error: 'Kon bericht niet versturen' });
      }
    });
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (urlError) {
      return '';
    }
  }

  function coversHost(host, marketHost) {
    const domain = marketHost.startsWith('www.') ? marketHost.slice(4) : marketHost;
    return host === domain || host.endsWith('.' + domain);
  }

  function serverMatches(serverUrl, originUrl) {
    const serverHost = hostOf(serverUrl);
    const originHost = hostOf(originUrl);
    if (!serverHost || !originHost) return false;
    if (serverHost === originHost) return true;

    return coversHost(serverHost, originHost) || coversHost(originHost, serverHost);
  }

  function serverLabel(serverUrl) {
    const match = servers.find(function (server) {
      return serverMatches(server.url, serverUrl);
    });
    return match ? match.name : hostOf(serverUrl) || 'onbekend';
  }

  function renderServers() {
    serverSelect.textContent = '';
    for (const server of servers) {
      const option = document.createElement('option');
      option.value = server.url;
      option.textContent = server.name;
      serverSelect.appendChild(option);
    }
  }

  async function prefillFromActiveTab() {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (tabsError) {
      return;
    }

    const tabUrl = tabs && tabs[0] ? tabs[0].url : '';
    if (!tabUrl) return;

    const server = servers.find(function (candidate) {
      return serverMatches(candidate.url, tabUrl);
    });
    if (!server) return;

    serverSelect.value = server.url;

    const worldPrefix = hostOf(tabUrl).split('.')[0];
    if (worldPrefix && worldPrefix !== 'www' && !worldInput.value) {
      worldInput.value = worldPrefix;
    }
  }

  async function loadServers() {
    const reply = await sendMessage({ type: TD.MessageType.GetServers });
    if (reply.error || !Array.isArray(reply.response)) {
      showMessage(reply.error || 'Kon serverlijst niet ophalen');
      return;
    }
    servers = reply.response;
    renderServers();
    await prefillFromActiveTab();
    render();
  }

  function accountStatusChip(status) {
    const chip = document.createElement('span');
    chip.classList.add('chip');
    if (status === TD.AccountStatus.Verified) {
      chip.classList.add('chip-verified');
      chip.textContent = 'Geverifieerd';
    } else if (status === TD.AccountStatus.PendingVerification) {
      chip.classList.add('chip-pending');
      chip.textContent = 'In afwachting';
    } else if (status === TD.AccountStatus.Expired) {
      chip.classList.add('chip-expired');
      chip.textContent = 'Verlopen';
    } else {
      chip.classList.add('chip-unverified');
      chip.textContent = 'Niet geverifieerd';
    }
    return chip;
  }

  function uploadStatusLabel(status) {
    if (status === TD.UploadStatus.Pending) return 'In wachtrij';
    if (status === TD.UploadStatus.Uploading) return 'Bezig';
    if (status === TD.UploadStatus.Done) return 'Geüpload';
    if (status === TD.UploadStatus.Failed) return 'Mislukt';
    if (status === TD.UploadStatus.NoAccount) return 'Geen account';
    return 'Onbekend';
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleString('nl-NL');
  }

  function formatTime(value) {
    const date = new Date(value);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  function buildTokenRow(account) {
    const row = document.createElement('div');
    row.classList.add('token-row');
    const tokenValue = document.createElement('span');
    tokenValue.classList.add('token-value');
    tokenValue.textContent = account.verifyToken || '';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = 'Kopieer';
    copyButton.addEventListener('click', function () {
      navigator.clipboard.writeText(account.verifyToken || '').then(function () {
        showMessage('Code gekopieerd naar klembord', true);
      }).catch(function () {
        showMessage('Kopiëren mislukt');
      });
    });
    row.appendChild(tokenValue);
    row.appendChild(copyButton);
    return row;
  }

  function buildAccountCard(account) {
    const card = document.createElement('div');
    card.classList.add('account-card');

    const head = document.createElement('div');
    head.classList.add('account-head');
    const name = document.createElement('span');
    name.classList.add('account-name');
    name.textContent = account.playerName || String(account.playerId || '');
    head.appendChild(name);
    head.appendChild(accountStatusChip(account.status));
    card.appendChild(head);

    if (account.status === TD.AccountStatus.Verified && account.tokenExpiresAt) {
      const detail = document.createElement('div');
      detail.classList.add('account-detail');
      detail.textContent = 'Geldig tot ' + formatDateTime(account.tokenExpiresAt);
      card.appendChild(detail);
    }

    if (account.status === TD.AccountStatus.PendingVerification || account.status === TD.AccountStatus.Unverified) {
      const instructions = document.createElement('div');
      instructions.classList.add('account-detail');
      instructions.textContent = 'Plak de code in je persoonlijke tekst op je profiel en klik daarna op Verifieer nu.';
      card.appendChild(instructions);
      card.appendChild(buildTokenRow(account));

      const actions = document.createElement('div');
      actions.classList.add('account-actions');
      const verifyButton = document.createElement('button');
      verifyButton.type = 'button';
      verifyButton.textContent = 'Verifieer nu';
      verifyButton.addEventListener('click', async function () {
        clearMessage();
        verifyButton.disabled = true;
        const reply = await sendMessage({ type: TD.MessageType.VerifyAccount, accessId: account.accessId });
        verifyButton.disabled = false;
        if (reply.error) {
          showMessage(reply.error);
        } else {
          showMessage('Account geverifieerd', true);
        }
        render();
      });
      actions.appendChild(verifyButton);
      card.appendChild(actions);
    }

    if (account.status === TD.AccountStatus.Expired) {
      const actions = document.createElement('div');
      actions.classList.add('account-actions');
      const renewButton = document.createElement('button');
      renewButton.type = 'button';
      renewButton.textContent = 'Opnieuw verifiëren';
      renewButton.addEventListener('click', async function () {
        clearMessage();
        renewButton.disabled = true;
        const reply = await sendMessage({ type: TD.MessageType.ReRequestAccess, accessId: account.accessId });
        renewButton.disabled = false;
        if (reply.error) {
          showMessage(reply.error);
        } else {
          showMessage('Nieuwe code aangevraagd. Plak de code in je profiel en klik op Verifieer nu.', true);
        }
        render();
      });
      actions.appendChild(renewButton);
      card.appendChild(actions);
    }

    return card;
  }

  function renderAccounts(accounts) {
    accountsList.textContent = '';
    if (!accounts.length) {
      const emptyNote = document.createElement('div');
      emptyNote.classList.add('empty-note');
      emptyNote.textContent = 'Nog geen accounts. Voeg hieronder een account toe.';
      accountsList.appendChild(emptyNote);
      return;
    }

    const groups = {};
    for (const account of accounts) {
      const groupKey = serverLabel(account.serverUrl) + ' / ' + (account.world || 'onbekend');
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(account);
    }

    for (const groupKey of Object.keys(groups).sort()) {
      const group = document.createElement('div');
      group.classList.add('world-group');
      const title = document.createElement('div');
      title.classList.add('world-title');
      title.textContent = groupKey;
      group.appendChild(title);
      for (const account of groups[groupKey]) {
        group.appendChild(buildAccountCard(account));
      }
      accountsList.appendChild(group);
    }
  }

  function renderLog(logEntries) {
    logList.textContent = '';
    const recent = logEntries.slice(-20).reverse();
    if (!recent.length) {
      const emptyNote = document.createElement('div');
      emptyNote.classList.add('empty-note');
      emptyNote.textContent = 'Nog geen uploads.';
      logList.appendChild(emptyNote);
      return;
    }
    for (const entry of recent) {
      const row = document.createElement('div');
      row.classList.add('log-row');
      const time = document.createElement('span');
      time.textContent = formatTime(entry.timestamp);
      const script = document.createElement('span');
      script.textContent = entry.script || '';
      script.title = entry.error || '';
      const server = document.createElement('span');
      server.textContent = entry.serverUrl ? serverLabel(entry.serverUrl) : '';
      server.title = entry.serverUrl || '';
      const world = document.createElement('span');
      world.textContent = entry.world || '';
      const status = document.createElement('span');
      status.classList.add('log-status-' + entry.status);
      status.textContent = uploadStatusLabel(entry.status);
      status.title = entry.error || '';
      row.appendChild(time);
      row.appendChild(script);
      row.appendChild(server);
      row.appendChild(world);
      row.appendChild(status);
      logList.appendChild(row);
    }
  }

  async function render() {
    const settings = await readStorage(TD.StorageKeys.Settings, {});
    autoUploadToggle.checked = settings.autoUploadEnabled !== false;
    const accounts = await readStorage(TD.StorageKeys.Accounts, []);
    renderAccounts(accounts);
    const logEntries = await readStorage(TD.StorageKeys.Log, []);
    renderLog(logEntries);
  }

  autoUploadToggle.addEventListener('change', async function () {
    const settings = await readStorage(TD.StorageKeys.Settings, {});
    settings.autoUploadEnabled = autoUploadToggle.checked;
    await writeStorage(TD.StorageKeys.Settings, settings);
    if (autoUploadToggle.checked) {
      sendMessage({ type: TD.MessageType.FlushQueue });
    }
  });

  addForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    clearMessage();
    const serverUrl = serverSelect.value;
    const world = worldInput.value.trim();
    const playerName = playerInput.value.trim();
    if (!serverUrl) {
      showMessage('Kies een server');
      return;
    }
    if (!world || !playerName) {
      showMessage('Vul wereld en spelersnaam in');
      return;
    }
    const reply = await sendMessage({ type: TD.MessageType.RequestAccess, serverUrl, world, playerName });
    if (reply.error) {
      showMessage(reply.error);
      return;
    }
    worldInput.value = '';
    playerInput.value = '';
    showMessage('Aanvraag verstuurd. Plak de code in je persoonlijke tekst op je profiel en klik daarna op Verifieer nu.', true);
    render();
  });

  try {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName === 'local') {
        render();
      }
    });
  } catch (listenerError) {
  }

  render();
  loadServers();
})();
