# 09 — Connectivity: friends (Cloudflare Tunnel + Access)

← [08 Tailscale](08-connectivity-tailscale.md) · Next: [10 Optional services](10-optional-comfyui-tabby.md)

> **Overview:** Configure Cloudflare Tunnel routing and Zero Trust Access policies to expose `llm.domain.com` (Open WebUI) and `api.domain.com` (LiteLLM API) to authorised friends, with email-allow-list authentication enforced at the Cloudflare edge.
>
> **Why:** Cloudflare handles TLS termination, DDoS mitigation, and email-based auth without opening any inbound ports on the server. The tunnel is outbound-only — no firewall changes are required.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<domain.com>` | Your registered domain on Cloudflare | Cloudflare dashboard → Websites |
> | Friend email addresses | Email addresses for Access allow-lists | Your list of people to authorise |

This exposes the UI and API to friends **without opening any router ports** and
without a VPN (decision **D1**). The `cloudflared` container already runs the
outbound tunnel using `CF_TUNNEL_TOKEN`. Now you configure routing + auth in the
Cloudflare dashboard.

Full settings reference: [`assets/cloudflare-access-notes.md`](assets/cloudflare-access-notes.md).

## 1. Confirm the tunnel is connected

Zero Trust → Networks → Tunnels → `home-llm` should show **Healthy**. If not:

```bash
microk8s kubectl logs -n llm-platform deploy/cloudflared --tail 50
```

## 2. Publish the hostnames

Every hostname points at the **same** in-cluster target — Traefik — which routes
by `Host` header to the right backend via the Gateway API
([step 04 §7–8](04-deploy-stack-ubuntu.md)). In the tunnel's **Published
application routes**:

| Public hostname | Service | Add when |
|---|---|---|
| `llm.domain.com` | `http://traefik.llm-platform:80` | Now |
| `api.domain.com` | `http://traefik.llm-platform:80` | Now |
| `auth.domain.com` | `http://traefik.llm-platform:80` | † [Step 14](14-identity-sso.md) — after Authentik and its `auth.` HTTPRoute exist |
| `admin.domain.com` | `http://traefik.llm-platform:80` | † [Step 16](16-admin-ui.md) — after the Admin UI and its `admin.` HTTPRoute exist |

> **† Add the last two rows later.** The `core-gateway` has `auth.` and `admin.`
> listeners, but no HTTPRoute attaches to them until Authentik (step 14) and the
> Admin UI (step 16) are deployed. Publish a tunnel route before its HTTPRoute
> exists and Traefik answers **404** for that hostname. Add `llm.` and `api.` now
> (their HTTPRoutes are created in step 04); return for `auth.` in step 14 and
> `admin.` in step 16.

`auth.domain.com` exposes only Authentik's OIDC endpoints — the WAF rules
in §5 block all other paths including the Authentik admin UI. Cloudflare
auto-creates the DNS records.

## 3. Access policy on the UI (`llm.domain.com`)

Zero Trust → Access → Applications → **Add (Self-hosted)**:

- Domain `llm.domain.com`, session 24h.
- **Allow** policy, **Emails** = each friend's address.
- Login methods: **Google** and/or **One-time PIN** (email code).

Result: only allow-listed people even reach the Open WebUI login; everyone else
is rejected at Cloudflare's edge.

## 4. Access on the API (`api.domain.com`) — bypass + key + WAF path blocks

API clients use a single credential: the LiteLLM virtual key (step 06) sent
as `Authorization: Bearer <key>`. `api.domain.com` is therefore **bypassed**
at CF Access and protected by LiteLLM auth + WAF rules downstream.

- Add a Self-hosted app for `api.domain.com`.
- **Bypass** policy, rule **Everyone**.
  (Auth, per-user budgets, and rate limits are enforced by LiteLLM.)

> **Accepted residual:** there is no edge-level identity check before a request
> reaches LiteLLM. The WAF allowlist (below) blocks all non-inference paths, and
> the LiteLLM virtual key is required for every inference request. LiteLLM's own
> `/key/*` admin endpoints are Tailscale-only and never routed through the
> `api.` tunnel directly — friend/key/user administration instead goes through
> the separately-gated Admin UI at `admin.domain.com` (step 16).

**Required WAF rule** — an **allowlist** in Security → WAF → **Custom rules** on
the `api.domain.com` **zone** (free plan allows 5 custom rules here; this is *not*
the Enterprise account-level WAF). Only the inference paths are permitted;
everything else is blocked by default, including any future LiteLLM admin endpoint.

> **Free/Pro plans cannot use the `matches` regex operator** (Business/Advanced WAF
> only). The allowlist below therefore uses the `starts_with()` + `lower()`
> functions, which are available on **all plans**. In the rule builder, switch to
> **Edit expression** and paste it (Action: **Block**):

```
http.host eq "api.domain.com" and not (starts_with(lower(http.request.uri.path), "/v1/chat/completions") or starts_with(lower(http.request.uri.path), "/v1/completions") or starts_with(lower(http.request.uri.path), "/v1/models") or starts_with(lower(http.request.uri.path), "/v1/responses") or starts_with(lower(http.request.uri.path), "/v1/messages") or starts_with(lower(http.request.uri.path), "/v1/embeddings"))
```

> **What this blocks:** only `/v1/chat/completions`, `/v1/completions`,
> `/v1/models`, `/v1/responses`, `/v1/messages`, and `/v1/embeddings` reach LiteLLM.
> Every other path — `/key/*`, **`/v1/key/*`**, `/budget/*`, `/team/*`,
> `/config/*`, `/spend/*`, `/health`, and any future admin route — is blocked.
> `lower()` normalises case so `/KEY/generate` or `/V1/Chat/Completions` can't
> bypass it. Admin operations go via a Tailscale-gated `kubectl port-forward` only
> — never the tunnel (see [step 06](06-gateway-litellm.md)).
>
> **On Business/Advanced WAF** you may prefer the tighter regex form (adds
> path-boundary anchoring): `http.host eq "api.domain.com" and not http.request.uri.path matches "(?i)^/v1/(chat/completions|completions|models|responses|messages|embeddings)(/|$|\?)"`

**Rate limiting (optional).** Add a **Rate limiting rule** on
`http.host eq "api.domain.com"`, counting **by IP**, action **Block**. On the
**Free plan the window and block duration are fixed at 10 s** (you can only set the
request threshold) — so express the ceiling per 10 s, e.g. **20 requests / 10 s**
(≈120/min; raise to 40–50 if legitimate coding-agent bursts trip it). Pro+ unlocks
a 1-minute window. This is a **coarse edge flood-backstop only** — the precise
per-user control is LiteLLM's **`rpm_limit`** (step 06), which limits each key
regardless of IP. If you'd rather not tune it, **skipping this rule is fine**;
LiteLLM already meters per key.

## 5. Access on the auth endpoint (`auth.domain.com`) — bypass + WAF path allowlist

`auth.domain.com` must be a **Bypass / Everyone** CF Access policy. CF Access
federates to Authentik as its OIDC provider, so gating the IdP itself with CF
Access creates a circular dependency — Cloudflare's servers need to reach
Authentik's token endpoint without any Access check during the login flow.

- Add a Self-hosted app for `auth.domain.com`.
- **Bypass** policy, rule **Everyone**.

The WAF path allowlist provides the protection:

**Required WAF rules** (Security → WAF → Custom rules on the `auth.domain.com`
zone):

| Rule | Expression | Action |
|---|---|---|
| Allow OIDC + login paths only | `http.host eq "auth.domain.com" and not http.request.uri.path matches "(?i)^(/.well-known/\|/application/o/\|/if/flow/\|/static/\|/ws/\|/api/v3/flows/\|/api/v3/root/\|/favicon)"` | Block |
| Rate limit login attempts | `http.host eq "auth.domain.com" and http.request.uri.path matches "(?i)^/if/flow/"` | Rate limit — 10 req/min/IP, block 5 min |

> **Free/Pro plan (no `matches` regex):** use the `starts_with()` + `lower()` form
> for the allowlist block instead (Action **Block**, via **Edit expression**):
> `http.host eq "auth.domain.com" and not (starts_with(lower(http.request.uri.path), "/.well-known/") or starts_with(lower(http.request.uri.path), "/application/o/") or starts_with(lower(http.request.uri.path), "/if/flow/") or starts_with(lower(http.request.uri.path), "/static/") or starts_with(lower(http.request.uri.path), "/ws/") or starts_with(lower(http.request.uri.path), "/api/v3/flows/") or starts_with(lower(http.request.uri.path), "/api/v3/root/") or starts_with(lower(http.request.uri.path), "/favicon"))`
> The login-flow rate-limit rule is optional on Free (see §4); Authentik's own
> brute-force lockout (step 14) is the primary control.

> **Why `/ws/` + `/api/v3/flows/` + `/api/v3/root/` are allowed:** Authentik's
> login page (`/if/flow/…`) is a JS app, not server-rendered HTML. After the shell
> loads it calls **`/api/v3/flows/executor/`** to render the actual
> username/password/MFA stages, **`/api/v3/root/config/`** for branding, and opens
> a **`wss://…/ws/client/`** live-update socket. If these are blocked, the shell
> loads but no login form ever appears and Cloudflare's OIDC login fails with
> "Response returned an error code" — while Authentik logs nothing past the shell
> (the blocked calls die at the edge). These paths serve the **public** login flow
> and are safe to expose; they are not the admin API.
>
> **What this still blocks:** `/if/admin/` (Authentik admin UI — Tailscale-only)
> and the sensitive REST API (`/api/v3/core/`, `/api/v3/providers/`,
> `/api/v3/policies/`, etc. — everything under `/api/v3/` *except* `flows/` and
> `root/`). The admin UI remains exclusively accessible via Tailscale direct
> access to the Authentik pod.
>
> **Accepted residual:** the OIDC and login-flow endpoints are publicly
> reachable. Mitigations: WAF rate limit on login flows, Authentik brute-force
> lockout (5 failed attempts → 30 min lock), and MFA enforced on all accounts
> (step 14). CVE exposure from public-facing Authentik is monitored by the
> Trivy Operator (step 13/H-29).

## 6. Tunnel token hygiene

`CF_TUNNEL_TOKEN` grants anyone who holds it the ability to register a connector
on your tunnel and intercept all traffic. It is stored as the
`cloudflared-credentials` Kubernetes Secret ([step 04 §3](04-deploy-stack-ubuntu.md)),
encrypted at rest by the `secretbox` provider ([step 04 §2](04-deploy-stack-ubuntu.md)),
and injected into the cloudflared pod via `secretKeyRef` — never a plaintext file
or a `docker inspect`-readable env literal.

**Set up connector notifications** so a leaked token that spawns a rogue
connector is detected immediately:

1. Zero Trust → Networks → Tunnels → `home-llm` → **Notifications** → **Add**
2. Event types: **Tunnel created or deleted** + **Connector connected or disconnected**
3. Notification channel: **Email** → your admin address
4. Save; verify the rules show a green checkmark on the Notifications tab

**Confirm the connector count** matches your cloudflared replicas:

- Zero Trust → Networks → Tunnels → `home-llm` → **Connectors** tab
- Expected: one connector per running `cloudflared` pod (2 by default — see the
  [cloudflared manifest](assets/k8s/llm-platform/cloudflared.yaml)), all **Active**

An *unexpected* extra connector is the primary indicator of a leaked token.

## 7. Why this is safe

- No inbound router rules; the tunnel is outbound-only and your home IP is hidden.
- UI: edge identity (CF Access email allowlist) **+** app login (Open WebUI).
- API: LiteLLM virtual key (per-user auth, budgets, rate limits) **+** WAF
  path allowlist (blocks all non-inference paths) **+** per-IP rate limit.
  LiteLLM's own admin endpoints require Tailscale access only — never routed
  through the `api.` tunnel directly. Friend/key/user administration instead
  goes through the separately-gated Admin UI at `admin.domain.com` (step 16).
- The inference engine is never exposed — cloudflared reaches only Traefik, which
  routes only to `open-webui` and `litellm`. Even a full cloudflared compromise
  gives no path to inference: the `inference-policy` NetworkPolicy
  ([step 04 §8](04-deploy-stack-ubuntu.md)) allows ingress from `litellm` alone.

## Verification

- `https://llm.domain.com` → Cloudflare login → Open WebUI. A non-allowlisted
  email is refused at the edge.
- `curl https://api.domain.com/v1/chat/completions -H "Authorization: Bearer <friend-key>" -d '{...}'` returns a completion; a bad key returns 401.
- `curl https://api.domain.com/key/info` returns **403 Blocked** (WAF allowlist — not in permitted paths).
- `curl https://api.domain.com/v1/key/generate` returns **403 Blocked** (WAF allowlist — /v1/key/ is not an inference path).
- `curl https://api.domain.com/health` returns **403 Blocked** (WAF allowlist).
- `curl https://api.domain.com/KEY/generate` returns **403 Blocked** (case-insensitive match).

→ Continue to [10 — Optional: ComfyUI + Tabby](10-optional-comfyui-tabby.md).
