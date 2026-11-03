# ADR 0002: TLS by DSM reverse proxy

## Context
The founding document assumed Caddy with a DNS-01 wildcard. The venue uses Synology DDNS
(`<venue>.synology.me`), for which no Caddy DNS-01 plugin exists, and DSM can itself
issue a wildcard Let's Encrypt certificate for that name.

## Decision
DSM's reverse proxy terminates TLS with the DSM-issued wildcard certificate and forwards
plain HTTP to the hub container. One reverse proxy rule per role hostname, WebSocket
headers enabled.

## Consequences
- No ACME code in the hub; DSM renews the certificate.
- The hub must trust forwarded headers only from the proxy and must not assume TLS
  itself.
- If Synology subdomain resolution or the wildcard turns out unavailable, the fallback is
  a custom domain with a CNAME to the DDNS name ([design/22](../design/22-deployment.md)).
