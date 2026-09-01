# Toxic Donut Uploader

Chrome Manifest V3 extension that automatically uploads Tribal Wars userscript data to the Toxic Donut portal API. Userscripts are no longer allowed to POST data themselves, so they publish upload envelopes into the page DOM and this extension picks them up, queues them, and delivers them to the backend with a per-account bearer token.

No build step, no framework. Plain JavaScript.

## Install (load unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this folder (`tw-uploader-extension`).
5. Pin the extension and open the popup to add an account.

## Account setup

1. Open the popup, enter the world (e.g. `nl95`) and your player name, click **Account toevoegen**.
2. The popup shows a verification code. Copy it and paste it into the personal text on your Tribal Wars profile.
3. Click **Verifieer nu**. Once verified, queued uploads for that world and player are sent automatically.

Expired tokens show a red **Verlopen** chip with an **Opnieuw verifiëren** button that requests a fresh code.

## DOM contract for userscripts

A userscript that has data to upload renders a hidden element on any `game.php` page:

```html
<div class="td-upload"
     id="td-upload-<script>-<uuid>"
     data-td-script="<scriptId>"
     data-td-state="pending"
     style="display:none">{JSON envelope}</div>
```

The element's text content is the JSON envelope:

```json
{
  "script": "incomings-enhancer",
  "version": "1.2.3",
  "world": "nl95",
  "playerId": 123456,
  "playerName": "donut_toxic",
  "sitterId": null,
  "exportedAt": "2026-08-31T12:00:00Z",
  "payload": {}
}
```

Known script ids: `incomings-enhancer`, `incomings-tags`, `tribeshare-report`, `tribeshare-village-info`, `scavenge-log`, `noblefarm-log`.

Lifecycle:

- The extension scans for `.td-upload[data-td-state="pending"]` on page load and watches for new elements with a MutationObserver.
- After the background accepts the envelope into its queue, the extension sets `data-td-state="accepted"` and dispatches `new CustomEvent('td-upload-consumed', { bubbles: true })` on the element.
- On failure it sets `data-td-state="failed"` and `data-td-error` with the reason.
- The extension never removes the element. The userscript may listen for `td-upload-consumed` to clean up its own local state.

Deduplication: items are deduped on the element uuid and on the combination `world + playerId + script + exportedAt`, so rendering the same envelope on multiple page loads is safe.

## Behavior

- Uploads go to `POST /api/v1.0/portal/upload` with `Authorization: Bearer <sessionToken>` for the matching verified account (world + playerId). The API base URL is a constant in `src/shared/constants.js`.
- Persistent queue in `chrome.storage.local`, flushed on new items, on service worker startup, and every minute via `chrome.alarms`.
- Retry backoff on network or server errors: 30s, 2m, 10m, 30m, then the item is marked failed.
- A 401 or 403 marks the account as expired and the item waits until the account is verified again.
- The queue is capped at 200 items (oldest done or failed items are dropped first) and a log of the last 100 upload results feeds the popup's recent uploads list.
- The toolbar badge shows the number of failed items plus items without a verified account.
- The auto-upload toggle in the popup header pauses all uploading without losing the queue.

## Structure

```
manifest.json
src/content/scanner.js          content script, scans DOM and forwards envelopes
src/background/service-worker.js  ES module entry, messaging and alarms
src/background/queue.js         persistent queue, retry, badge, log
src/background/api.js           fetch wrappers for the portal API
src/popup/popup.html|js|css     account management and upload log
src/shared/constants.js         API base, enums, storage keys
icons/                          placeholder icons
```
