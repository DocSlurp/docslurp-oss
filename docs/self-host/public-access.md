# Public access

Put a TLS reverse proxy such as Caddy, nginx, or Traefik in front of the
localhost server port. Set `SELFHOST_URL=https://your-domain` and
`BETTER_AUTH_TRUST_PROXY_HEADERS=true` if your proxy overwrites forwarded
headers. Keep `SERVER_BIND_ADDRESS=127.0.0.1` when the proxy runs on the same machine. Forward
normal HTTP requests and long-lived event streams without buffering; the server
uses live progress updates. If the proxy is on another host, bind the server to an
address reachable only on your private network and firewall the port.

For Caddy on the same host, a minimal site block is:

```caddyfile
your-domain.example {
  reverse_proxy 127.0.0.1:8787
}
```

## Block internal endpoints

`/ready` returns full dependency detail (latencies, schema version, error text)
to every caller in the Compose stack, and `/metrics` is meant for your own
scraper. Keep both off the public edge:

```caddyfile
your-domain.example {
  @internal path /ready /metrics
  respond @internal 404
  reverse_proxy 127.0.0.1:8787
}
```

`/health` stays reachable. Scrape `/metrics` from inside your private network.

## Client IP behind a proxy or CDN

Rate limits, audit logs and sign-in limits key on the client address. With no
proxy configured the server uses the right-most `X-Forwarded-For` entry
(`API_TRUSTED_PROXY_HOPS`, default 1) or `X-Real-IP`. Set `TRUSTED_PROXIES` to
a comma-separated list of the `cloudflare` keyword and/or CIDRs for the proxies
in front of the app:

| Setup | `TRUSTED_PROXIES` | Client address comes from |
| --- | --- | --- |
| Caddy/nginx only | unset (or the proxy's CIDR) | `X-Forwarded-For` the proxy appends |
| Cloudflare, then your proxy | `cloudflare,127.0.0.1` | `X-Forwarded-For`, skipping trusted hops from the right |
| Fly.io behind Cloudflare | `cloudflare` | `CF-Connecting-IP`, only if `Fly-Client-IP` is a Cloudflare address |

Forwarded headers are never read from a peer outside this set, so a client that
reaches the origin directly cannot choose its own address. `CF-Connecting-IP` is
honoured only for peers in Cloudflare's published ranges (pinned in
[`packages/shared/src/cloudflare-ips.ts`](../../packages/shared/src/cloudflare-ips.ts); refresh with
`node scripts/update-cloudflare-ips.mjs`). Your proxy must overwrite, not
append to, any client-supplied `X-Forwarded-For`/`X-Real-IP`. To refuse
requests that skip the proxy, set `REQUIRE_TRUSTED_PROXY=true` (default off;
health and metrics paths stay open).

Do not publish the Postgres, Redis, MinIO, or Temporal ports. This Compose file
does not bind them to the host. See [Security](security.md) for the full list of
exposed and internal services. For public use, configure
[backups](operations.md#backups-and-restore) and monitor disk, memory, worker
errors, and the `/health` endpoint before inviting users.
