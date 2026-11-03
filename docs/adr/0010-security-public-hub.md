# ADR 0010: Security model for a publicly reachable hub

## Decision

Two PINs (operate, edit) with Argon2id hashing and session cookies scoped to the venue
domain; per-output URL tokens; IP and global rate limiting on PIN entry; role declared
on every route; strict headers and CSP; forwarded headers trusted only from DSM.

## Reasons

- The venue exposes the hub through DSM so volunteers can prepare from home; a LAN-trust
  model is not available.
- Two PINs give the separation the venue asked for (edit cannot control live) with no
  user accounts to manage.

## Consequences

- Accounts and per-user audit come later with cloud sync; the schema leaves `savedBy`
  free text for now.
- Output tokens appear in URLs; rotation is one click and relaunches outputs.
