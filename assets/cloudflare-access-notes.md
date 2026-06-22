# Cloudflare Tunnel + Access — settings reference

Companion to [step 08](../08-connectivity-cloudflare.md). All configured in the
Cloudflare dashboard (no files on the server beyond the tunnel token in `.env`).

## 1. Tunnel public hostnames

Zero Trust → Networks → Tunnels → `home-llm` → **Published application routes**:

| Public hostname | Service (inside the tunnel) |
|---|---|
| `llm.domain.com` | `http://open-webui:8080` |
| `api.domain.com` | `http://litellm:4000` |

> The service hostnames are the Docker service names because `cloudflared` runs
> on the same `llmnet` network. If you instead run cloudflared outside Docker,
> use `http://localhost:3000` for the UI and publish LiteLLM's port.

## 2. Access application — UI (`llm.domain.com`)

Zero Trust → Access → Applications → **Add (Self-hosted)**:

- **Application domain:** `llm.domain.com`
- **Session duration:** 24h (tune to taste)
- **Policy → Allow**, rule type **Emails**: list each friend's email.
  - Add login methods: **Google** and/or **One-time PIN** (email code).
- Everyone not listed is rejected at Cloudflare's edge.

## 3. Access application — API (`api.domain.com`)

API clients can't do an interactive browser login, so this host is **bypassed**
at Access and protected by the LiteLLM virtual key + a rate limit instead.

- **Add application (Self-hosted)** for `api.domain.com`
- **Policy → Bypass**, rule **Everyone**.
  (Auth is enforced downstream by LiteLLM's bearer key.)

### Optional hardening — service tokens
For clients that *can* send custom headers (Codex, opencode), add a second
**Allow** policy with rule **Service Token** and issue a token per such client.
GUI tools (JetBrains AI Assistant) can't send these, so keep the Bypass policy
for them. Order policies so Bypass remains the catch-all.

## 4. WAF rate limit on the API host

Security → WAF → **Rate limiting rules** → Create:

- **If** `http.host eq "api.domain.com"`
- **Then** rate limit, e.g. **60 requests / 1 min per IP** (tune up for heavy
  agent use), action **Block** for 60s.

## 5. DNS note

Access/Tunnel work as soon as Cloudflare is your **DNS** (nameserver change).
A full registrar transfer can finish later; it is not a blocker.
