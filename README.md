# Toxic Donut Uploader

Chrome Manifest V3 extension that automatically uploads Tribal Wars userscript data to the Toxic Donut portal API. Userscripts are no longer allowed to POST data themselves, so they publish upload envelopes into the page DOM and this extension picks them up, queues them, and delivers them to the backend with a per-account bearer token.

No build step, no framework. Plain JavaScript. The UI is translated with `chrome.i18n` (Dutch, English and German, default Dutch).

## Install (load unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this folder (`tw-uploader-extension`).
5. Pin the extension and open the popup to add an account.

## Account setup

1. Open the popup. When a Tribal Wars game tab is active the server and world are prefilled from it; otherwise pick the server and then the world from the dropdowns (the world list comes from `GET /api/v1.0/portal/worlds?serverUrl=`). Add your player name and click **Account toevoegen**.
2. The popup shows a verification code. Copy it and paste it into the personal text on your Tribal Wars profile.
3. Click **Verifieer nu**. Once verified, queued uploads for that world and player are sent automatically.

Expired tokens show a red **Verlopen** chip with an **Opnieuw verifiëren** button that requests a fresh code.

Verified accounts show their read key with a copy button; scripts that read data from the portal need it. Every account has a **Verwijderen** button (click twice to confirm) that calls `DELETE /api/v1.0/portal/access/{accessId}` and removes the account locally, also when the backend answers 401 or 404. The popup footer links to the portal at https://portal.toxicdonut.dev.

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
  "version": 1,
  "world": "nl95",
  "serverUrl": "https://nl95.tribalwars.nl",
  "playerId": 123456,
  "playerName": "donut_toxic",
  "sitterId": 0,
  "exportedAt": 1756641600000,
  "payload": {}
}
```

`version` is an integer, `sitterId` is `0` when the player is not sitting, and `exportedAt` is a unix timestamp in
milliseconds (`Date.now()`). `serverUrl` is `location.origin` of the game tab and is what binds the upload to a
market; envelopes without it are rejected, and the extension falls back to the content script's own origin only for
older script versions. The backend rejects an export older than 24 hours.

Known script ids: `incomings-enhancer`, `incomings-tags`, `tribeshare-report`, `tribeshare-village-info`, `scavenge-log`, `noblefarm-log`.

Lifecycle:

- The extension scans for `.td-upload[data-td-state="pending"]` on page load and watches for new elements with a MutationObserver.
- After the background accepts the envelope into its queue, the extension sets `data-td-state="accepted"` and dispatches `new CustomEvent('td-upload-consumed', { bubbles: true })` on the element.
- On failure it sets `data-td-state="failed"` and `data-td-error` with the reason.
- The extension never removes the element. The userscript may listen for `td-upload-consumed` to clean up its own local state.

Deduplication: items are deduped on the element uuid and on the combination `serverUrl + world + playerId + script + exportedAt`, so rendering the same envelope on multiple page loads is safe, and identical world names on two markets do not collide.

## Behavior

- Uploads go to `POST /api/v1.0/portal/upload` with `Authorization: Bearer <sessionToken>` for the matching verified account (world + playerId). The API base URL is a constant in `src/shared/constants.js`.
- Persistent queue in `chrome.storage.local`, flushed on new items, on service worker startup, and every minute via `chrome.alarms`.
- Retry backoff on network or server errors: 30s, 2m, 10m, 30m, then the item is marked failed.
- A 401 means the session expired: the account is marked expired (the popup shows **Opnieuw verifiëren**) and the item waits, without using a retry, until the account is verified again. A 403 does the same with an invalid token message. Other 4xx answers (409 validation, 413 too large) mark the item failed.
- While an item is being sent its status is `Uploading`; items left in that state by a stopped service worker go back to the queue on the next flush.
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
src/shared/i18n.js              tdText helper around chrome.i18n.getMessage
_locales/nl|en|de/messages.json  translations (default nl)
icons/                          Toxic Donut logo
```

## Supported markets

`manifest.json` lists the markets the content script runs on and the extension may talk to: `tribalwars.nl`,
`tribalwars.net`, `die-staemme.de`, `tribalwars.cash` and `tribalwars.works`. These mirror the servers marked
Supported in the backend. Enabling a new market in the backend admin page is not enough: add its pattern to both
`host_permissions` and `content_scripts[].matches` and release a new extension version.
