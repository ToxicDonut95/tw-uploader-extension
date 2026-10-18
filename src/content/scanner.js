(function () {
  const inFlight = new Set();

  function markFailed(element, errorMessage) {
    element.setAttribute('data-td-state', 'failed');
    element.setAttribute('data-td-error', errorMessage);
  }

  function markAccepted(element) {
    element.setAttribute('data-td-state', 'accepted');
    element.removeAttribute('data-td-error');
    element.dispatchEvent(new CustomEvent('td-upload-consumed', { bubbles: true }));
  }

  function processElement(element) {
    if (element.getAttribute('data-td-state') !== 'pending') return;
    const elementId = element.id || '';
    const flightKey = elementId || element;
    if (inFlight.has(flightKey)) return;
    inFlight.add(flightKey);

    let envelope = null;
    try {
      envelope = JSON.parse(element.textContent);
    } catch (parseError) {
      envelope = null;
    }
    if (!envelope || typeof envelope !== 'object') {
      inFlight.delete(flightKey);
      markFailed(element, tdText('errorInvalidJson'));
      return;
    }

    let sent = false;
    try {
      chrome.runtime.sendMessage({ type: TD.MessageType.Upload, elementId, envelope, origin: location.origin }, function (reply) {
        inFlight.delete(flightKey);
        if (chrome.runtime.lastError) {
          markFailed(element, chrome.runtime.lastError.message || tdText('errorNoExtensionConnection'));
          return;
        }
        if (!reply) {
          markFailed(element, tdText('errorNoExtensionReply'));
          return;
        }
        if (reply.accepted) {
          markAccepted(element);
        } else if (reply.paused) {
          return;
        } else {
          markFailed(element, reply.error || tdText('errorUnknown'));
        }
      });
      sent = true;
    } catch (sendError) {
      sent = false;
    }
    if (!sent) {
      inFlight.delete(flightKey);
      markFailed(element, tdText('errorNoExtensionContext'));
    }
  }

  function scanRoot(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const pendingElements = root.querySelectorAll('.td-upload[data-td-state="pending"]');
    for (const element of pendingElements) {
      processElement(element);
    }
  }

  function collectFromNode(node, collected) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.classList && node.classList.contains('td-upload')) {
      collected.push(node);
    }
    if (typeof node.querySelectorAll === 'function') {
      for (const nested of node.querySelectorAll('.td-upload')) {
        collected.push(nested);
      }
    }
  }

  let debounceTimer = null;
  const pendingNodes = [];

  function flushPendingNodes() {
    debounceTimer = null;
    const nodes = pendingNodes.splice(0, pendingNodes.length);
    const collected = [];
    for (const node of nodes) {
      collectFromNode(node, collected);
    }
    for (const element of collected) {
      if (element.isConnected && element.getAttribute('data-td-state') === 'pending') {
        processElement(element);
      }
    }
  }

  function onMutations(mutations) {
    let sawCandidate = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        pendingNodes.push(node);
        sawCandidate = true;
      }
    }
    if (!sawCandidate) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPendingNodes, 250);
  }

  scanRoot(document);

  if (document.body) {
    const observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
