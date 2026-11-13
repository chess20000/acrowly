# Acrowly Pure Chat API Specification

> **Design Philosophy**: Minimalist, zero-GUI headless agent API. The chat channel transmits **pure conversation text only** (just like real humans texting). Images and files are uploaded separately and referenced inside message text as Markdown links. **Video is strictly unsupported and rejected.**

---

## 1. Base URL & Routing Modes

1. **Local Direct**: `http://127.0.0.1:8787` (or configured port)
2. **Hosted Relay (`acrowly.com`)** for hosts without a public IP:
   - Subdomain mode: `https://<deviceId>.acrowly.com`
   - Path prefix mode: `https://acrowly.com/d/<deviceId>/`
   - Header mode (ideal for iOS App): `https://acrowly.com` with header `X-Acrowly-Device: <deviceId>`

> **Note for WebUI developers**: Use relative `./api/...` URLs (or resolve relative to `location.pathname` when served under `/d/<deviceId>/`) so the same WebUI works seamlessly on both `localhost` and `acrowly.com`.

---

## 2. Authentication (SSH-Style Ed25519 Public Key Only)

**No passwords, no static API tokens.** Every Acrowly client (iOS App via `CryptoKit`, WebUI via `WebCrypto`, CLI via `~/.acrowly/id_ed25519`) **must include built-in Ed25519 keygen**. The private key never leaves the client device; the client's public key is added to the host's authorized keys (via Coordinator chat or `acl add-key`).

### Supported Public Key Formats
- OpenSSH line: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... optional-label`
- Raw 32-byte Ed25519 public key (Base64 / Base64URL — e.g. Apple CryptoKit `rawRepresentation` or WebCrypto `exportKey("raw")`)
- SPKI PEM (`-----BEGIN PUBLIC KEY-----...`)

### `GET /api/auth/status`
Check authentication and key-authorization state.
```json
{
  "authenticated": true,
  "authConfigured": true,
  "authorizedKeyCount": 2,
  "deviceId": "home-mac",
  "relayConnected": true
}
```
- **Localhost before first key**: Local loopback (`127.0.0.1` / `::1`) allows access when `authorizedKeyCount === 0` so the user can add their first device public key.
- **Remote / Relay access**: Requests arriving via `acrowly.com` relay or non-loopback interfaces strictly require `authorizedKeyCount > 0` and valid Ed25519 session authentication (`403` if no keys configured yet, `401` if unauthenticated).

### `POST /api/auth/challenge`
Step 1 of SSH-like handshake: request a 60-second single-use challenge nonce for a client public key (rate-limited).
```json
{ "fingerprint": "SHA256:..." }
```
*(Or `{ "publicKey": "ssh-ed25519 AAAA..." }` / raw Base64).*
Response (`200 OK`, or `401` if key is not in `authorizedKeys`):
```json
{
  "challengeId": "chg_...",
  "nonce": "...",
  "message": "acrowly-auth-v1:home-mac:chg_...:...",
  "expiresAt": "2026-11-13T06:50:00.000Z"
}
```

### `POST /api/auth/verify`
Step 2 of SSH-like handshake: sign the exact UTF-8 bytes of `message` with the client's Ed25519 private key and submit the 64-byte signature (Base64 or Base64URL).
```json
{
  "challengeId": "chg_...",
  "signature": "<base64-ed25519-signature>"
}
```
Response (`200 OK`): sets `HttpOnly` cookie `acrowly_session` (for browsers / `<img>` tags) and returns:
```json
{
  "ok": true,
  "token": "<signed-session-token>",
  "keyId": "key_...",
  "label": "iphone",
  "fingerprint": "SHA256:..."
}
```
Native clients (iOS App, `acl chat`) pass `Authorization: Bearer <token>` on subsequent requests (and silently repeat `/challenge` + `/verify` if the session expires).

---

## 3. Pure Text Chat Endpoints

### Message Schema (`ChatMessage`)
```json
{
  "seq": 12,
  "id": "msg_01J...",
  "role": "user",
  "text": "帮我分析一下这张截图 ![img](/api/files/file_01J.../shot.png)",
  "createdAt": "2026-11-13T06:25:00.000Z"
}
```
- `seq`: Strictly monotonically increasing integer (`1, 2, 3, ...`) across the single continuous conversation timeline.
- `role`: `"user"` | `"assistant"`.
- `text`: Plain / Markdown text. Images appear as `![alt](/api/files/<id>/<name>)` and downloadable files as `[name](/api/files/<id>/<name>)`.

### `GET /api/chat/messages`
Fetch chat history from the single continuous timeline.
- Query parameters:
  - `after_seq` (optional integer): Return messages with `seq > after_seq` in ascending order.
  - `before_seq` (optional integer): Return older messages with `seq < before_seq` (for scrolling up).
  - `limit` (optional integer, default `50`, max `200`).
- Response (`200 OK`):
```json
{
  "messages": [ ... ],
  "latestSeq": 12
}
```

### `POST /api/chat/messages`
Send a user message into the conversation. Returns immediately (`202 Accepted`) without blocking on Coordinator reasoning or subagent work.
- Request JSON:
```json
{
  "text": "帮我写一个极简的本地网页前端",
  "clientMsgId": "optional-client-uuid-for-idempotency"
}
```
- Response (`202 Accepted` or `200 OK` if deduplicated):
```json
{
  "message": {
    "seq": 13,
    "id": "msg_...",
    "role": "user",
    "text": "帮我写一个极简的本地网页前端",
    "createdAt": "2026-11-13T06:26:00.000Z"
  },
  "duplicate": false
}
```

### `GET /api/chat/stream?after_seq=0`
Server-Sent Events (`text/event-stream`) real-time stream.
- First replays any messages with `seq > after_seq`, then pushes live messages as they arrive across all devices (CLI, WebUI, iOS App, Coordinator replies, proactive notifications).
- Supports standard `Last-Event-ID` header or `after_seq` query parameter.
- Event format:
```text
id: 14
event: message
data: {"seq":14,"id":"msg_...","role":"assistant","text":"收到，我让子代理马上帮你写一个极简版！","createdAt":"2026-11-13T06:26:02.000Z"}

: ping
```

---

## 4. Images & Files Endpoints (No Video)

### `POST /api/files`
Upload an image or non-video file.
- Accepts `multipart/form-data` with field `file`, OR raw binary body with `X-Filename` and `Content-Type` headers.
- **Video Rejection**: Any `video/*` MIME type, video file extension (`.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`, `.flv`, `.m4v`, `.wmv`, `.3gp`, `.mpeg`, `.mpg`, `.ts`), or video container signature is rejected with `415 Unsupported Media Type`.
- Response (`201 Created`):
```json
{
  "id": "file_01J...",
  "kind": "image",
  "name": "screenshot.png",
  "mime": "image/png",
  "size": 102400,
  "url": "/api/files/file_01J.../screenshot.png",
  "markdown": "![screenshot.png](/api/files/file_01J.../screenshot.png)"
}
```
- The client includes `markdown` directly inside `text` when calling `POST /api/chat/messages`.

### `GET /api/files/:id` and `GET /api/files/:id/:filename`
Retrieve an uploaded or Coordinator-generated image/file.
- Supports `HttpOnly` session cookie (for `<img>` tags) and `Authorization: Bearer <token>` (for iOS App / scripts).
- Append `?download=1` to force `Content-Disposition: attachment`.

---

## 5. Custom WebUI Rules (For Subagents Writing `./webui/`)

When building or modifying `./webui/index.html`:
1. **Zero dependencies / zero build step**: Write pure HTML + CSS + ES Module JS so changes take effect immediately on browser refresh.
2. **Built-in Ed25519 keygen & challenge auth**: Use browser `crypto.subtle` (`Ed25519`) to generate and store a local keypair (`IndexedDB` / JWK); if unauthenticated (`401` on `/api/auth/challenge`), display the client's public key with a one-click Copy button so the user can authorize it with Coordinator, then complete `/api/auth/challenge` + `/api/auth/verify`.
3. **Single chat interface only**: Display only the single continuous chat feed and message composer. No multi-session lists, no settings panels, no sidebars.
4. **Supported media only**: Render text (safe Markdown), inline images (`<img>` from `/api/files/...`), and file download cards. Never add `<video>` rendering or video upload/recording controls; restrict file pickers away from `video/*`.
5. **Cross-device responsive**: Must work comfortably on both desktop browsers and mobile screens (iPhone/Android Safari/Chrome).
6. **Realtime sync**: Load initial messages via `GET ./api/chat/messages`, subscribe to `GET ./api/chat/stream?after_seq=...`, deduplicate by `seq`, send via `POST ./api/chat/messages`, and upload images/files (paste, drag-drop, or picker) via `POST ./api/files`. Resolve `/api/files/...` links cleanly even when hosted under `/d/<deviceId>/`.
