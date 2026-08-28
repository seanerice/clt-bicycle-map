# nginx/

TLS-terminating reverse proxy config for the `nginx` service in
[`docker-compose.prod.yml`](../docker-compose.prod.yml) — proxies
`bikemap-api.seanerice.dev` to the compose-internal `api` service (see
[`conf.d/api.conf`](./conf.d/api.conf)), per
[`docs/planning/deployment.md`](../docs/planning/deployment.md) §3
("Backend: EC2 + docker-compose"). Single-level subdomain, not
`api.bikemap.seanerice.dev` — see `conf.d/api.conf`'s header comment for
why (Cloudflare's free Universal SSL edge cert only covers one level of
wildcard, discovered during story 8.7's cutover).

## Certificate

**The cert this story uses is a locally-generated self-signed
stand-in, not the real production certificate.**

Prod terminates the Cloudflare-to-origin TLS leg with a **Cloudflare
Origin CA certificate** (Cloudflare already terminates edge TLS for the
domain, SSL mode "Full (strict)" — see deployment.md §3). That
certificate is issued by hand in the Cloudflare dashboard — it isn't
scriptable via AWS CLI or any other API this repo automates — and gets
installed at `nginx/certs/` on the box during story 8.7. That is the one
manual step nothing in stories 8.1-8.4 automates; it is a deliberate gap,
not an oversight.

For this story (8.3), [`generate-dev-cert.sh`](./generate-dev-cert.sh)
generates a throwaway self-signed cert+key into `nginx/certs/` (git-ignored)
so the nginx/docker-compose wiring can be proven out locally with real TLS
handshakes:

```
bash nginx/generate-dev-cert.sh
```

`docker-compose.prod.yml` bind-mounts `nginx/certs/` read-only into the
`nginx` container at `/etc/nginx/certs`. Swapping in the real Origin CA
cert later (8.7) is just replacing the two files at that same path — no
config change needed.
