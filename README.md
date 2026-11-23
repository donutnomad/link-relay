# Link Relay

A small relay server and a browser extension that let you:

- **Sign in with Google on another browser.** OAuth redirects are intercepted on a secondary browser, completed on your primary browser, and the result is relayed back.
- **Mirror Gmail** from your primary browser to a secondary one through a short-lived pairing link.
- **Block external-protocol jumps** (anything other than http/https) and show the blocked link instead, with copy and one-time allow buttons.

## Contents

| Path | Description |
|---|---|
| `cross.go`, `web/` | Relay server (Go, no third-party dependencies) |
| `extension/` | Browser extension (Manifest V3) for Chrome / Edge, with a Firefox manifest |
| `link-relay.user.js` | The same features as a userscript (Tampermonkey / Violentmonkey), with an in-page settings panel and auto-update |

## Relay server

Requires Go 1.21+ (the module file targets a newer toolchain; adjust `go.mod` if needed).

```sh
export BRIDGE_SECRET='a-long-random-string'
go run .            # listens on :18999
# or
go build -o cross . && ./cross
```

`BRIDGE_SECRET` is **required**; the server refuses to start without it. Clients authenticate with `Authorization: Bearer <secret>`.

Put the server behind HTTPS (for example with a reverse proxy) before using it from real browsers.

Sessions are short-lived and kept in memory: OAuth sessions expire after 3 minutes and Gmail mirror sessions after 5 minutes.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /oauth/create` | Register an OAuth session |
| `GET /go/<code>` | Open the registered OAuth URL on the primary browser |
| `POST /oauth/callback` | Receive the OAuth callback URL |
| `GET /oauth/poll` | Secondary browser polls for the result |
| `GET /wait/<code>` | Waiting page on the secondary browser |
| `POST /mail/push` | Primary browser pushes inbox data and message bodies |
| `GET /mail/events` | SSE stream telling the primary browser which message to fetch |
| `GET /mail/data`, `GET /mail/stream` | Mirror data for the secondary browser |
| `GET /mail/<code>` | Mirror web UI |

## Extension

Build:

```sh
cd extension
./build.sh          # outputs dist/chrome, dist/firefox and zip files
```

Install:

- **Chrome / Edge:** open `chrome://extensions` (or `edge://extensions`), enable developer mode, choose "Load unpacked" and select `extension/dist/chrome`.
- **Firefox (temporary):** open `about:debugging#/runtime/this-firefox`, choose "Load Temporary Add-on" and select `extension/dist/firefox/manifest.json`. Firefox does not grant host permissions automatically; use the button on the settings page to grant them.

Then open the extension's settings page and fill in:

- the relay server URL (for example `https://relay.example.com`)
- the API key (the same value as `BRIDGE_SECRET`)
- whether external-protocol interception is enabled

The API key is stored locally in the browser (`chrome.storage.local`) and is only sent to your relay server.

## Userscript

Install from the raw URL (your userscript manager will offer to install it):

```
https://raw.githubusercontent.com/donutnomad/link-relay/main/link-relay.user.js
```

Open the script's menu in your userscript manager and choose "Open settings panel" to enter the relay server URL and API key. Do not run the userscript and the extension in the same browser at the same time.

### Notes

- The extension needs access to all sites because the protocol blocker and OAuth hooks run on every page.
- OAuth callback URLs and Gmail content pass through your relay server, so only use a server you control and trust.
- Gmail mirroring may not comply with the Chrome Web Store policies; the extension is intended to be loaded manually.
