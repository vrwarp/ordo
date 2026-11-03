# PRD 09: Security and remote preparation

The hub is published on the internet through the Synology DSM reverse proxy on the
venue's synology.me hostname so volunteers can prepare from home. The security model
must hold on a public address from M1.

## Roles and credentials

| Role | Grants | Credential |
| --- | --- | --- |
| Operate | Operator view, live control, launching outputs, stage tools, settings | Operate PIN |
| Edit | Library, editor, playlists, imports, media upload; no live control | Edit PIN |
| Output | An output or stage window: receives live state and media only | Per-output token in the URL, issued by the hub, rotatable |

- PINs are at least 6 digits, stored hashed on the hub, set during first-run setup and
  changeable by the Operate role.
- A session lasts 12 hours on the venue PC (remembered device) and 1 hour elsewhere,
  renewed on activity. Sessions are HTTP-only, Secure, SameSite cookies.
- Rate limiting: 5 failed PIN attempts per IP per 15 minutes, then a lockout of 15 minutes
  with a clear message. Attempts are logged.
- Output tokens are long random strings embedded in the output URL that the operator app
  generates when launching. Opening an output URL without a valid token shows nothing.
  Tokens can be rotated from settings, which relaunches outputs.

## Editing from home

- The edit role can do everything in the library except touch the live playlist and the
  presentations it references, which are locked while a playlist is live.
- Concurrent editors: last save wins with a revision created for every save; the editor
  warns when the presentation changed since it was opened and offers to reload.
- Uploads from home are transcoded on the NAS and appear when done.

## Transport

- TLS terminated by DSM's reverse proxy using the DSM-managed wildcard certificate.
- The hub trusts `X-Forwarded-*` headers only from the reverse proxy's address.
- Strict security headers on every page: `Origin-Agent-Cluster: ?1`, CSP limiting scripts
  to self, `Permissions-Policy` allowing only what each role needs (HID and MIDI on the
  operator origin, fullscreen and window management on outputs), HSTS.
- WebSocket connections carry the session cookie or the output token; unauthenticated
  sockets are closed after the first message.

## Data

- No analytics or external calls from the venue PC except Google Fonts fetches made by
  the hub when a font is added.
- Backups stay on the NAS; offsite copies are the venue's Hyper Backup configuration.

## Acceptance

- A scanner hitting the public hostname sees a login page and is locked out after five
  wrong PINs.
- An output URL copied without its token renders nothing and logs the attempt.
- The edit role cannot GO, clear or launch outputs even by crafting API calls.
