# 08 — Connectivity: friends (Cloudflare Tunnel + Access)

← [07 Open WebUI](07-webui-open-webui.md) · Next: [09 Tailscale](09-connectivity-tailscale.md)

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
docker logs cloudflared --tail 50
```

## 2. Publish the hostnames

In the tunnel's **Published application routes**:

| Public hostname | Service |
|---|---|
| `llm.domain.com` | `http://open-webui:8080` |
| `api.domain.com` | `http://litellm:4000` |
| `admin.domain.com` | `http://admin-ui:8080` |
| `auth.domain.com` | `http://authentik-server:9000` |

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
> the LiteLLM virtual key is required for every inference request. Admin
> operations are Tailscale-only and never routed through the tunnel.

**Required WAF rules** (Security → WAF → Custom rules on the `api.domain.com`
zone). Use an **allowlist** approach — only the specific inference paths are
permitted; everything else is blocked by default (including any future LiteLLM
admin endpoint not listed here):

| Rule | Expression | Action |
|---|---|---|
| Allow inference paths only | `http.host eq "api.domain.com" and not http.request.uri.path matches "(?i)^/v1/(chat/completions\|completions\|models\|responses\|messages\|embeddings)(/\|$\|\?)"` | Block |
| Rate limit | `http.host eq "api.domain.com"` | Rate limit — 60 req/min/IP, block 60 s |

> **Allowlist approach:** only `/v1/chat/completions`, `/v1/completions`,
> `/v1/models`, `/v1/responses`, `/v1/messages`, and `/v1/embeddings` are
> publicly reachable. Every other path — including `/key/*`, **`/v1/key/*`**,
> `/budget/*`, `/team/*`, `/config/*`, `/spend/*`, `/health`, and any future
> LiteLLM admin route — is blocked by the first rule without requiring a
> dedicated block entry. The `(?i)` flag makes matching case-insensitive,
> preventing capitalisation bypasses (e.g. `/KEY/generate`, `/V1/Chat/Completions`).
> Admin operations go via Tailscale only (direct to port 4000 — step 06).

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
| Allow OIDC + login paths only | `http.host eq "auth.domain.com" and not http.request.uri.path matches "(?i)^(/.well-known/\|/application/o/\|/if/flow/\|/static/\|/favicon)"` | Block |
| Rate limit login attempts | `http.host eq "auth.domain.com" and http.request.uri.path matches "(?i)^/if/flow/"` | Rate limit — 10 req/min/IP, block 5 min |

> **What this blocks:** `/if/admin/` (Authentik admin UI — Tailscale-only),
> `/api/v3/` (Authentik REST API), and any Authentik path not part of the OIDC
> or interactive login flow. The admin UI remains exclusively accessible via
> Tailscale direct access to the Authentik pod.
>
> **Accepted residual:** the OIDC and login-flow endpoints are publicly
> reachable. Mitigations: WAF rate limit on login flows, Authentik brute-force
> lockout (5 failed attempts → 30 min lock), and MFA enforced on all accounts
> (step 15). CVE exposure from public-facing Authentik is monitored by the
> Trivy Operator (step 14/H-29).

## 6. Tunnel token — store as a k8s Secret

`CF_TUNNEL_TOKEN` grants anyone who holds it the ability to register a
connector on your tunnel and intercept all traffic. Store it as a k8s Secret,
not in a plaintext file.

**Step 1 — Set up connector notifications before doing anything else.**
During the migration below, two connectors will briefly be active simultaneously.
If the token was already leaked, an attacker could register a third connector
during that window. Notifications must be in place before the window opens:

1. Zero Trust → Networks → Tunnels → `home-llm` → **Notifications** → **Add**
2. Select event types: **Tunnel created or deleted** + **Connector connected or disconnected**
3. Notification channel: **Email** → your admin address
4. Save, then verify the rules appear with a green checkmark on the Notifications tab

**Step 2 — Create the k8s Secret.**

Use `--from-file` so the token value never appears as a command-line argument
(which would persist it in shell history and `/proc/<pid>/cmdline`):

```bash
# Create the temp file at mode 600 before writing — default umask 022 would
# otherwise produce mode 644, making it world-readable
install -m 600 /dev/null /tmp/cf-token

# Strip the trailing newline that grep|cut produces — --from-file stores bytes
# verbatim, so a trailing newline would be included in the Secret value and
# could cause cloudflared authentication failures
grep 'CF_TUNNEL_TOKEN=' /opt/home-llm/.env | cut -d= -f2 | tr -d '\n' > /tmp/cf-token

microk8s kubectl create secret generic cloudflared-credentials \
  --namespace llm-platform \
  --from-file=token=/tmp/cf-token

# /tmp is tmpfs (RAM-backed); shred provides no guarantee on tmpfs.
# rm -f is sufficient — the pages are reclaimed on next memory pressure or reboot.
rm -f /tmp/cf-token
```

Reference it in the cloudflared Deployment:

```yaml
env:
- name: TUNNEL_TOKEN
  valueFrom:
    secretKeyRef:
      name: cloudflared-credentials
      key: token
```

**Step 3 — Cut over and stop the Docker Compose container.**

Once the cloudflared Deployment is running and confirmed healthy, stop the
Docker Compose `cloudflared` container. If it keeps running, the token remains
live in its environment and readable via `docker inspect cloudflared` by any
docker-group member — and two connectors are simultaneously registered on the
tunnel (the MITM scenario C-5 describes):

```bash
# Confirm the k8s connector is active first
microk8s kubectl rollout status deployment/cloudflared -n llm-platform

# Then stop and remove the Docker Compose container
docker compose stop cloudflared
docker compose rm -f cloudflared
```

**Step 4 — Clean up `.env` and confirm connector count.**

```bash
# GNU sed on Linux preserves the original file's permissions (fchmod before rename),
# so chmod 600 set in step 04 is maintained after this edit.
sed -i 's/^CF_TUNNEL_TOKEN=.*/CF_TUNNEL_TOKEN=MOVED_TO_K8S_SECRET/' /opt/home-llm/.env
```

Confirm exactly one connector remains:

- Zero Trust → Networks → Tunnels → `home-llm` → **Connectors** tab
- Expected: exactly 1 connector, status **Active**

A second connector appearing is the primary indicator of a leaked token.

> **Secrets at rest:** MicroK8s stores k8s Secrets in dqlite, which is
> base64-encoded but **not encrypted** by default. An attacker with host
> filesystem access can read the token from dqlite directly. For defence-in-depth,
> enable k8s EncryptionConfiguration (AES-CBC or AES-GCM provider) following
> the [Kubernetes docs on encrypting data at rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/),
> or ensure the host disk is encrypted with LUKS. Tracked as **H-14** in
> [`security-review.md`](security-review.md).

## 7. Why this is safe

- No inbound router rules; the tunnel is outbound-only and your home IP is hidden.
- UI: edge identity (CF Access email allowlist) **+** app login (Open WebUI).
- API: LiteLLM virtual key (per-user auth, budgets, rate limits) **+** WAF
  path allowlist (blocks all non-inference paths) **+** per-IP rate limit.
  Admin operations require Tailscale access only — never routed through the tunnel.
- The inference engine is never exposed — only `open-webui` and `litellm` are
  routed. Even a full cloudflared container compromise gives no direct path to
  inference (Docker network isolation — see step 04).

## Verification

- `https://llm.domain.com` → Cloudflare login → Open WebUI. A non-allowlisted
  email is refused at the edge.
- `curl https://api.domain.com/v1/chat/completions -H "Authorization: Bearer <friend-key>" -d '{...}'` returns a completion; a bad key returns 401.
- `curl https://api.domain.com/key/info` returns **403 Blocked** (WAF allowlist — not in permitted paths).
- `curl https://api.domain.com/v1/key/generate` returns **403 Blocked** (WAF allowlist — /v1/key/ is not an inference path).
- `curl https://api.domain.com/health` returns **403 Blocked** (WAF allowlist).
- `curl https://api.domain.com/KEY/generate` returns **403 Blocked** (case-insensitive match).

→ Continue to [09 — Connectivity: admin (Tailscale)](09-connectivity-tailscale.md).
