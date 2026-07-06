# Cloudflare Tunnel + Access — settings reference

Companion to [step 08](../08-connectivity-cloudflare.md). All configured in the
Cloudflare dashboard (no files on the server beyond the tunnel token, held in the
`cloudflared-credentials` Kubernetes Secret).

## 1. Tunnel public hostnames

Zero Trust → Networks → Tunnels → `home-llm` → **Published application routes**:

| Public hostname | Service (inside the tunnel) |
|---|---|
| `llm.domain.com` | `http://traefik.llm-platform:80` |
| `api.domain.com` | `http://traefik.llm-platform:80` |
| `admin.domain.com` | `http://traefik.llm-platform:80` |
| `auth.domain.com` | `http://traefik.llm-platform:80` |

> Every hostname points at the same target — Traefik. cloudflared forwards each
> tunnel request to `traefik.llm-platform:80`, and Traefik dispatches by `Host`
> header to the right backend via the Gateway API (step 04). Add `admin.` and
> `auth.` only after their HTTPRoutes exist (steps 17 and 15).

## 2. Access application — UI (`llm.domain.com`)

Zero Trust → Access → Applications → **Add (Self-hosted)**:

- **Application domain:** `llm.domain.com`
- **Session duration:** 24h (tune to taste)
- **Policy → Allow**, rule type **Emails**: list each friend's email.
  - Add login methods: **Google** and/or **One-time PIN** (email code).
- Everyone not listed is rejected at Cloudflare's edge.

## 3. Access application — API (`api.domain.com`)

API clients use a single credential — the LiteLLM virtual key — sent as a
standard `Authorization: Bearer <key>` header. `api.domain.com` is therefore
**bypassed** at CF Access; auth, per-user budgets, and rate limits are enforced
downstream by LiteLLM.

- **Add application (Self-hosted)** for `api.domain.com`
- **Policy → Bypass**, rule **Everyone**.

> **Accepted residual:** no edge-level identity check precedes the LiteLLM key
> check. The WAF allowlist (step 08 §4) blocks all non-inference paths so
> unauthenticated callers cannot reach admin endpoints. Admin operations require
> Tailscale and are never routed through the tunnel.

## 4. Access application — Admin UI (`admin.domain.com`)

Zero Trust → Access → Applications → **Add (Self-hosted)**:

- **Application domain:** `admin.domain.com`
- **Session duration:** 4 hours
- **Enable cookie refresh** so active sessions extend automatically without
  forcing re-login mid-task (Zero Trust → Access → Applications → Settings →
  **Enable binding cookie** / session refresh on activity)
- **Policy → Allow**, rule type **Emails**: list operator/admin email addresses
  only — this should be the smallest list of any CF Access application
- Login method: Authentik OIDC (same IdP as all other services)
- Everyone not listed is rejected at the Cloudflare edge before reaching the
  Admin UI

> The Admin UI enforces a second gate: Authentik OIDC with `grp-admin` group
> check. A user who somehow passes CF Access but is not in `grp-admin` is
> rejected with 403 at the application layer.

## 5. Access application — Authentik OIDC (`auth.domain.com`)

`auth.domain.com` must be **Bypass / Everyone** — CF Access federates to
Authentik as its OIDC provider, so an Access policy here creates a circular
dependency. WAF rules provide the protection layer instead.

Zero Trust → Access → Applications → **Add (Self-hosted)**:

- **Application domain:** `auth.domain.com`
- **Policy → Bypass**, rule **Everyone**

**WAF path allowlist** (Security → WAF → Custom rules):

| Rule | Expression | Action |
|---|---|---|
| Allow OIDC + login paths only | `http.host eq "auth.domain.com" and not http.request.uri.path matches "(?i)^(/.well-known/\|/application/o/\|/if/flow/\|/static/\|/favicon)"` | Block |
| Rate limit login attempts | `http.host eq "auth.domain.com" and http.request.uri.path matches "(?i)^/if/flow/"` | Rate limit — 10 req/min/IP, block 5 min |

This blocks `/if/admin/` (Authentik admin UI — Tailscale-only access only)
and `/api/v3/` while allowing the OIDC discovery document, authorization,
token, and userinfo endpoints required for the login flow.

## 6. WAF rate limit on the API host

Security → WAF → **Rate limiting rules** → Create:

- **If** `http.host eq "api.domain.com"`
- **Then** rate limit, e.g. **60 requests / 1 min per IP** (tune up for heavy
  agent use), action **Block** for 60s.

## 7. DNS note

Access/Tunnel work as soon as Cloudflare is your **DNS** (nameserver change).
A full registrar transfer can finish later; it is not a blocker.
