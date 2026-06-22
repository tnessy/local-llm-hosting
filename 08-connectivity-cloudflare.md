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

## 4. Access on the API (`api.domain.com`) — bypass + key

API clients can't do a browser login, so this host is **bypassed** at Access and
protected by the LiteLLM virtual key (step 06) + a WAF rate limit.

- Add a Self-hosted app for `api.domain.com`.
- **Bypass** policy, rule **Everyone**.
- Security → WAF → Rate limiting: if `http.host eq "api.domain.com"`, limit
  ~60 req/min/IP, block 60 s.
- *(Optional)* For header-capable clients (Codex, opencode) add an **Allow /
  Service Token** policy and issue tokens — see the notes file.

## 5. Why this is safe

- No inbound router rules; the tunnel is outbound-only and your home IP is hidden.
- UI: edge identity (Access) **+** app login (Open WebUI).
- API: edge rate-limit/WAF **+** per-user virtual key (LiteLLM).
- The inference engine is never exposed — only `open-webui` and `litellm` are
  routed.

## Verification

- `https://llm.domain.com` → Cloudflare login → Open WebUI. A non-allowlisted
  email is refused at the edge.
- `curl https://api.domain.com/v1/chat/completions -H "Authorization: Bearer
  <friend-key>" -d '{...}'` returns a completion; a bad key returns 401.

→ Continue to [09 — Connectivity: admin (Tailscale)](09-connectivity-tailscale.md).
