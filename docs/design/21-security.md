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
- Pictures of a native PowerPoint import (design/27 §4, §12) are identified by their header, read with
  bounded reads, never by name. ffmpeg reads each only through the demuxer of the format it was checked as,
  with the file-only protocol whitelist and `-max_pixels` from the header's size; a picture stored ready
  (without a media job) must be a still PNG, JPEG, GIF or WebP within 8,192 px a side and 40 MP, and one
  import decodes at most 6,000 MP.
- Uploads: size limit 4 GB, extension and sniffed MIME must agree, stored under a hash
  name, never executed. ffmpeg, LibreOffice and pdftoppm run with a timeout, a memory
  limit, and no network.
- LibreOffice never sees a deck as uploaded (design/27 §5 "Render copy", §12). A CPU-pool task writes
  a render copy: every XML part re-written from the bounded parser's tree (no declaration or entity
  survives), every relationship and the content types rebuilt under generated part names, and
  External targets, `vbaProject.bin`, OLE binaries, embedded packages and fonts, ActiveX, media
  payloads, notes, comments and custom XML left out. soffice then runs through `sofficeToPdf`
  (`apps/hub/src/pptx/fallback.ts`): `prlimit --as` (2 GiB), `unshare -rn` (an empty network
  namespace) where the container allows it, else proxy variables pointing at a dead port, a
  throwaway profile and `HOME` in the job's scratch directory, a minimal environment, and the
  `tools.run` timeout that kills its whole process group (`soffice.bin` included). The native
  import and the 'Pictures (LibreOffice)' import share this path.
- Import zips: path traversal rejected; member count and total size capped.
- PowerPoint decks for the native import (design/27 §12) are parsed only on the CPU pool (512 MB heap,
  2 minutes per batch of slides, 15 minutes per import), never on the event loop; when the pool cannot start
  the import fails cleanly (the picture import cannot build its render copy either, and LibreOffice never
  sees a deck as uploaded: a 'Pictures (LibreOffice)' import whose copy cannot be built fails too). Zip reading skips what is never read (embeddings,
  `vbaProject.bin`, custom XML, document properties), keeps XML parts within 8 MB each and 64 MB in all,
  extracts only referenced pictures (≤ 2,000, ≤ 1 GiB) under generated names, and expands no nested zip;
  the LibreOffice follow-up, reference pictures, the picture import and the text repair read decks the same
  way, and a zip whose entries' data overlap is refused. A picture is kept as it is only within its pixels'
  bytes (4 a pixel plus 1 MiB, at most 64 MiB); a larger one is re-encoded, so no deck ships padding.
  A part or slide that cannot be read makes that slide a picture slide, never the deck.
- Deck-derived strings (titles, file names, section and part names, hosts) reach a job log line or
  `source.log` only with control characters and line breaks removed and cut to 200 characters, so a deck
  cannot forge `[warn]`/`[error]` lines or a log line's time stamp.
- Clipboard HTML pasted into the editor is untrusted (any page a volunteer copies from can write it,
  `data-ordo-objects` included). The editor reads it with a bounded tokenizer (4 M characters, 100,000
  nodes, 256 levels, linear time, no throw: `CLIPBOARD_LIMITS`, fuzzed), keeps only slide objects that pass
  the schema, the importers' sanitizer and the render clamp, drops their re-import identity, and pastes at
  most what a slide draws; an error boundary keeps a render error from unmounting the operator window
  (design/15 "Clipboard", "Errors"). The hub's schema check on save stays the last line.

## Secrets and logs

- No secrets in the image. PINs are set on first run. Tokens never appear in logs (URLs
  are logged with the token redacted).
- Diagnostics export strips cookies, tokens and PIN hashes.

## Dependencies

Renovate or Dependabot weekly; `pnpm audit` in CI fails on high severity.
