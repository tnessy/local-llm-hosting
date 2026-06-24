# 08 — Connectivity: friends (Cloudflare Tunnel + Access)

← [07 Open WebUI](07-webui-open-webui.md) · Next: [09 Tailscale](09-connectivity-tailscale.md)

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

## 2. Publish the two hostnames

In the tunnel's **Published application routes**:

| Public hostname | Service |
|---|---|
| `llm.domain.com` | `http://open-webui:8080` |
| `api.domain.com` | `http://litellm:4000` |

Cloudflare auto-creates the DNS records.

## 3. Access policy on the UI (`llm.domain.com`)

Zero Trust → Access → Applications → **Add (Self-hosted)**:

- Domain `llm.domain.com`, session 24h.
- **Allow** policy, **Emails** = each friend's address.
- Login methods: **Google** and/or **One-time PIN** (email code).

Result: only allow-listed people even reach the Open WebUI login; everyone else
is rejected at Cloudflare's edge.

## 4. Access on the API (`api.domain.com`) — bypass + key + WAF path blocks

API clients can't do a browser login, so this host is **bypassed** at Access and
protected by the LiteLLM virtual key (step 06) + WAF rules.

- Add a Self-hosted app for `api.domain.com`.
- **Bypass** policy, rule **Everyone**.
- *(Optional)* For header-capable clients (Codex, opencode) add an **Allow /
  Service Token** policy and issue tokens — see the notes file.

**Required WAF rules** (Security → WAF → Custom rules on the `api.domain.com`
zone). These block LiteLLM admin paths that must never be reachable from the
public internet — admin operations go via Tailscale only (step 06):

| Rule | Expression | Action |
|---|---|---|
| Block LiteLLM admin paths | `http.host eq "api.domain.com" and http.request.uri.path matches "^/(key|user|model/info|health)"` | Block |
| Rate limit inference paths | `http.host eq "api.domain.com"` | Rate limit — 60 req/min/IP, block 60 s |

> The `/v1/*` inference paths (chat/completions, responses, messages) remain
> publicly reachable and are protected solely by the per-user LiteLLM virtual
> key. Admin paths (`/key/*`, `/user/*`, `/model/info`, `/health`) are
> unreachable from the internet regardless of key possession.

## 5. Tunnel token — store as a k8s Secret

`CF_TUNNEL_TOKEN` grants anyone who holds it the ability to register a
connector on your tunnel and intercept all traffic. Store it as a k8s Secret,
not in a plaintext file:

```bash
microk8s kubectl create secret generic cloudflared-credentials \
  --namespace llm-platform \
  --from-literal=token=<CF_TUNNEL_TOKEN>
```

Reference it in the cloudflared Deployment (not as an env var from a file):

```yaml
env:
- name: TUNNEL_TOKEN
  valueFrom:
    secretKeyRef:
      name: cloudflared-credentials
      key: token
```

Enable **connector notifications** in Cloudflare Zero Trust → Networks →
Tunnels → `home-llm` → Notifications. This alerts you immediately if a second
connector registers — the primary indicator of a leaked token.

## 6. Why this is safe

- No inbound router rules; the tunnel is outbound-only and your home IP is hidden.
- UI: edge identity (Access) **+** app login (Open WebUI).
- API: WAF blocks admin paths + rate limit **+** per-user virtual key (LiteLLM). Admin operations require Tailscale access.
- The inference engine is never exposed — only `open-webui` and `litellm` are
  routed, and LiteLLM admin paths are WAF-blocked.

## Verification

- `https://llm.domain.com` → Cloudflare login → Open WebUI. A non-allowlisted
  email is refused at the edge.
- `curl https://api.domain.com/v1/chat/completions -H "Authorization: Bearer <friend-key>" -d '{...}'` returns a completion; a bad key returns 401.
- `curl https://api.domain.com/key/info` returns **403 Blocked** (WAF rule).
- `curl https://api.domain.com/health` returns **403 Blocked** (WAF rule).

→ Continue to [09 — Connectivity: admin (Tailscale)](09-connectivity-tailscale.md).
