# Design 21: Security

The hub is reachable from the internet through DSM's reverse proxy. This document is the
implementation of [prd/09](../prd/09-security-and-remote-prep.md).

## Threat model

- Internet scanners and opportunistic attackers hitting the public hostname.
- A person who finds an output URL (a screenshot, a shared link) trying to view live
  content or to reach the API.
- A volunteer with the edit PIN who should not be able to control the live service.
- Not in scope: a compromised NAS or LAN, or a hostile operator.

## Authentication

| Credential            | Storage                                                 | Lifetime                                           |
| --------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Operate PIN, Edit PIN | Argon2id hashes in `settings`                           | Until changed                                      |
| Session cookie        | Random 32 bytes, SQLite `sessions` with role and expiry | 12 h on remembered devices, 1 h otherwise, sliding |
| Output token          | Random 32 bytes, hashed per output                      | Until rotated                                      |

- `POST /auth/pin` compares against both hashes and returns the matching role, so there is
  one login form.
- Remembered device: a checkbox sets a second long-lived cookie bound to the user agent
  hash; it only extends the session lifetime, it does not skip the PIN.
- Rate limiting: a token bucket per forwarded IP (5 per 15 min) and a global bucket (50
  per 15 min) on `/auth/pin`. Lockouts are logged with the IP.

## Authorisation

- Every route declares `role: 'operate' | 'edit' | 'output' | 'public'`; a startup check
  fails the process if a route lacks one.
- `operate` includes `edit`.
- Live events over WebSocket are accepted only from `operate` sessions. Edit sessions'
  sockets receive `library.delta` only.
- Output tokens authorise `GET /files/*`, `GET /cache/manifest`, `GET /live` and the
  WebSocket as role `output`, nothing else.

## Transport and headers

- DSM terminates TLS. The hub listens on plain HTTP on the Docker network, trusts
  `X-Forwarded-For` and `X-Forwarded-Proto` only from `ORDO_TRUSTED_PROXY`, and rejects
  non-HTTPS forwarded requests except on the Docker network itself.
- Headers on every response: `Strict-Transport-Security: max-age=31536000`,
  `Origin-Agent-Cluster: ?1`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`
  on the operator origin (keeps the opener for popups it opens while isolating from
  others), and a CSP:
  `default-src 'self'; connect-src 'self' https://hub.<venue>.synology.me wss://hub.<venue>.synology.me; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'`.
- `Permissions-Policy`: operator origin `hid=(self), midi=(self), window-management=(self), fullscreen=(self)`; output origins `fullscreen=(self), screen-wake-lock=(self), window-management=(self)`; stage `screen-wake-lock=(self), fullscreen=(self)`.
- Cookies: `Secure; HttpOnly; SameSite=Lax; Domain=.<venue>.synology.me; Path=/`.
- WebSocket origin check: the `Origin` header must be one of the known role origins.

## Input handling

- All bodies validated with Zod; unknown keys rejected.
- Uploads: size limit 4 GB, extension and sniffed MIME must agree, stored under a hash
  name, never executed. ffmpeg, LibreOffice and pdftoppm run with a timeout, a memory
  limit, and no network.
- Import zips: path traversal rejected; member count and total size capped.

## Secrets and logs

- No secrets in the image. PINs are set on first run. Tokens never appear in logs (URLs
  are logged with the token redacted).
- Diagnostics export strips cookies, tokens and PIN hashes.

## Dependencies

Renovate or Dependabot weekly; `pnpm audit` in CI fails on high severity.
