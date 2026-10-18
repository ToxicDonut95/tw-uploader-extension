(function () {
  const accountsList = document.getElementById('accounts-list');
  const logList = document.getElementById('log-list');
  const messageBox = document.getElementById('message');
  const autoUploadToggle = document.getElementById('auto-upload-toggle');
  const addForm = document.getElementById('add-account-form');
  const worldSelect = document.getElementById('world-select');
  const playerInput = document.getElementById('player-input');
  const serverSelect = document.getElementById('server-select');
  const portalLink = document.getElementById('portal-link');
  const text = globalThis.tdText;

  let servers = [];
  let worldsRequest = 0;

  function uiLocale() {
    try {
      return chrome.i18n.getUILanguage() || undefined;
    } catch (i18nError) {
      return undefined;
    }
  }

  function localizePage() {
    const locale = uiLocale();
    if (locale) {
      document.documentElement.lang = locale;
    }
    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = text(element.getAttribute('data-i18n'));
    }
    portalLink.href = TD.PORTAL_URL;
  }

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
            resolve({ response: null, error: chrome.runtime.lastError.message || text('errorNoBackgroundConnection') });
            return;
          }
          resolve(reply || { response: null, error: text('errorNoBackgroundReply') });
        });
      } catch (sendError) {
        resolve({ response: null, error: text('errorSendFailed') });
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
    return match ? match.name : hostOf(serverUrl) || text('unknownLabel');
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

  function setWorldPlaceholder(messageKey) {
    worldSelect.textContent = '';
    const option = document.createElement('option');
    option.value = '';
    option.textContent = text(messageKey);
    worldSelect.appendChild(option);
    worldSelect.disabled = true;
  }

  function renderWorlds(worlds, preferredWorld) {
    if (!worlds.length) {
      setWorldPlaceholder('worldsEmpty');
      return;
    }
    worldSelect.textContent = '';
    for (const world of worlds) {
      const option = document.createElement('option');
      option.value = world.prefix;
      option.textContent = world.name && world.name !== world.prefix ? world.name + ' (' + world.prefix + ')' : world.prefix;
      worldSelect.appendChild(option);
    }
    worldSelect.disabled = false;
    const preferred = worlds.find(function (world) {
      return preferredWorld && String(world.prefix).toLowerCase() === preferredWorld.toLowerCase();
    });
    if (preferred) {
      worldSelect.value = preferred.prefix;
    }
  }

  async function loadWorlds(serverUrl, preferredWorld) {
    const requestId = ++worldsRequest;
    if (!serverUrl) {
      setWorldPlaceholder('worldsNoServer');
      return;
    }
    setWorldPlaceholder('worldsLoading');
    const reply = await sendMessage({ type: TD.MessageType.GetWorlds, serverUrl });
    if (requestId !== worldsRequest) return;
    if (reply.error || !Array.isArray(reply.response)) {
      setWorldPlaceholder('errorWorldsFailed');
      showMessage(reply.error || text('errorWorldsFailed'));
      return;
    }
    renderWorlds(reply.response, preferredWorld);
  }

  async function activeTabWorld() {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (tabsError) {
      return null;
    }

    const tabUrl = tabs && tabs[0] ? tabs[0].url : '';
    if (!tabUrl) return null;

    const server = servers.find(function (candidate) {
      return serverMatches(candidate.url, tabUrl);
    });
    if (!server) return null;

    const worldPrefix = hostOf(tabUrl).split('.')[0];
    return { serverUrl: server.url, world: worldPrefix && worldPrefix !== 'www' ? worldPrefix : '' };
  }

  async function loadServers() {
    setWorldPlaceholder('worldsLoading');
    const reply = await sendMessage({ type: TD.MessageType.GetServers });
    if (reply.error || !Array.isArray(reply.response)) {
      setWorldPlaceholder('worldsNoServer');
      showMessage(reply.error || text('errorServersFailed'));
      return;
    }
    servers = reply.response;
    renderServers();
    const tabWorld = await activeTabWorld();
    if (tabWorld) {
      serverSelect.value = tabWorld.serverUrl;
    }
    render();
    await loadWorlds(serverSelect.value, tabWorld ? tabWorld.world : '');
  }

  function accountStatusChip(status) {
    const chip = document.createElement('span');
    chip.classList.add('chip');
    if (status === TD.AccountStatus.Verified) {
      chip.classList.add('chip-verified');
      chip.textContent = text('statusVerified');
    } else if (status === TD.AccountStatus.PendingVerification) {
      chip.classList.add('chip-pending');
      chip.textContent = text('statusPending');
    } else if (status === TD.AccountStatus.Expired) {
      chip.classList.add('chip-expired');
      chip.textContent = text('statusExpired');
    } else {
      chip.classList.add('chip-unverified');
      chip.textContent = text('statusUnverified');
    }
    return chip;
  }

  function uploadStatusLabel(status) {
    if (status === TD.UploadStatus.Pending) return text('uploadPending');
    if (status === TD.UploadStatus.Uploading) return text('uploadUploading');
    if (status === TD.UploadStatus.Done) return text('uploadDone');
    if (status === TD.UploadStatus.Failed) return text('uploadFailed');
    if (status === TD.UploadStatus.NoAccount) return text('uploadNoAccount');
    return text('uploadUnknown');
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleString(uiLocale());
  }

  function formatTime(value) {
    const date = new Date(value);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
  }

  function buildCopyRow(value, copiedMessageKey, labelKey) {
    const row = document.createElement('div');
    row.classList.add('token-row');
    if (labelKey) {
      const label = document.createElement('span');
      label.classList.add('token-label');
      label.textContent = text(labelKey);
      row.appendChild(label);
    }
    const tokenValue = document.createElement('span');
    tokenValue.classList.add('token-value');
    tokenValue.textContent = value || '';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = text('copyButton');
    copyButton.addEventListener('click', function () {
      navigator.clipboard.writeText(value || '').then(function () {
        showMessage(text(copiedMessageKey), true);
      }).catch(function () {
        showMessage(text('copyFailed'));
      });
    });
    row.appendChild(tokenValue);
    row.appendChild(copyButton);
    return row;
  }

  function buildRemoveButton(account) {
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.classList.add('remove-button');
    removeButton.textContent = text('removeButton');
    let confirming = false;
    removeButton.addEventListener('click', async function () {
      if (!confirming) {
        confirming = true;
        removeButton.textContent = text('confirmRemoveButton');
        removeButton.classList.add('remove-confirm');
        return;
      }
      clearMessage();
      removeButton.disabled = true;
      const reply = await sendMessage({ type: TD.MessageType.RemoveAccount, accessId: account.accessId });
      removeButton.disabled = false;
      if (reply.error) {
        showMessage(reply.error);
      } else {
        showMessage(text('accountRemoved'), true);
      }
      render();
    });
    return removeButton;
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
      detail.textContent = text('validUntil', [formatDateTime(account.tokenExpiresAt)]);
      card.appendChild(detail);
    }

    if (account.status === TD.AccountStatus.Verified && account.readKey) {
      card.appendChild(buildCopyRow(account.readKey, 'readKeyCopied', 'readKeyLabel'));
    }

    const actions = document.createElement('div');
    actions.classList.add('account-actions');

    if (account.status === TD.AccountStatus.PendingVerification || account.status === TD.AccountStatus.Unverified) {
      const instructions = document.createElement('div');
      instructions.classList.add('account-detail');
      instructions.textContent = text('verifyInstructions');
      card.appendChild(instructions);
      card.appendChild(buildCopyRow(account.verifyToken, 'codeCopied'));

      const verifyButton = document.createElement('button');
      verifyButton.type = 'button';
      verifyButton.textContent = text('verifyNowButton');
      verifyButton.addEventListener('click', async function () {
        clearMessage();
        verifyButton.disabled = true;
        const reply = await sendMessage({ type: TD.MessageType.VerifyAccount, accessId: account.accessId });
        verifyButton.disabled = false;
        if (reply.error) {
          showMessage(reply.error);
        } else {
          showMessage(text('accountVerified'), true);
        }
        render();
      });
      actions.appendChild(verifyButton);
    }

    if (account.status === TD.AccountStatus.Expired) {
      const renewButton = document.createElement('button');
      renewButton.type = 'button';
      renewButton.textContent = text('reverifyButton');
      renewButton.addEventListener('click', async function () {
        clearMessage();
        renewButton.disabled = true;
        const reply = await sendMessage({ type: TD.MessageType.ReRequestAccess, accessId: account.accessId });
        renewButton.disabled = false;
        if (reply.error) {
          showMessage(reply.error);
        } else {
          showMessage(text('newCodeRequested'), true);
        }
        render();
      });
      actions.appendChild(renewButton);
    }

    actions.appendChild(buildRemoveButton(account));
    card.appendChild(actions);

    return card;
  }

  function renderAccounts(accounts) {
    accountsList.textContent = '';
    if (!accounts.length) {
      const emptyNote = document.createElement('div');
      emptyNote.classList.add('empty-note');
      emptyNote.textContent = text('noAccounts');
      accountsList.appendChild(emptyNote);
      return;
    }

    const groups = {};
    for (const account of accounts) {
      const groupKey = serverLabel(account.serverUrl) + ' / ' + (account.world || text('unknownLabel'));
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
      emptyNote.textContent = text('noUploads');
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
    const world = worldSelect.disabled ? '' : worldSelect.value;
    const playerName = playerInput.value.trim();
    if (!serverUrl) {
      showMessage(text('errorChooseServer'));
      return;
    }
    if (!world || !playerName) {
      showMessage(text('errorWorldAndPlayer'));
      return;
    }
    const reply = await sendMessage({ type: TD.MessageType.RequestAccess, serverUrl, world, playerName });
    if (reply.error) {
      showMessage(reply.error);
      return;
    }
    playerInput.value = '';
    showMessage(text('requestSent'), true);
    render();
  });

  serverSelect.addEventListener('change', function () {
    clearMessage();
    loadWorlds(serverSelect.value, '');
  });

  try {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName === 'local') {
        render();
      }
    });
  } catch (listenerError) {
  }

  localizePage();
  render();
  loadServers();
})();
