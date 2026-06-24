# 06 — API gateway: LiteLLM

← [05 Inference](05-inference-tabbyapi-llamaswap.md) · Next: [07 Open WebUI](07-webui-open-webui.md)

LiteLLM (decision **D5**) is the single API front door. It:

- issues a **virtual key per friend**, each with budget / rate-limit / model
  allowlist,
- translates dialects so **Codex** (Responses API) and **Claude Code**
  (Anthropic Messages) work against the OpenAI-compatible engine,
- routes every model to `http://inference:8080/v1` (llama-swap).

Config: [`assets/litellm-config.yaml`](assets/litellm-config.yaml).

> **Security:** All admin operations (`/key/*`, `/user/*`, `/model/info`,
> `/health`) must be performed **via Tailscale only** (direct to
> `http://<server>:4000` on the tailnet). These paths are blocked at the
> Cloudflare WAF on `api.domain.com` — see [step 08](08-connectivity-cloudflare.md).
> Never run admin calls against the public hostname.

## 1. Confirm it's running

```bash
# Run from your Tailscale-connected machine or directly on the server
curl -s http://<server>:4000/health
```

## 2. Mint the Open WebUI key

Open WebUI authenticates to LiteLLM with its own virtual key:

```bash
curl -s http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"models":["coder","chat"],"key_alias":"open-webui"}'
```

Copy the returned `key` (`sk-...`) into `.env` as `OPENWEBUI_LITELLM_KEY`, then:

```bash
docker compose up -d open-webui     # restart so it picks up the key
```

## 3. Mint a key per API friend

One key each, with guardrails:

```bash
curl -s http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "models": ["coder","chat"],
        "max_budget": 20,
        "budget_duration": "30d",
        "rpm_limit": 60,
        "key_alias": "alice"
      }'
```

Give each friend their `sk-...` key (used in [step 12](12-clients.md)).

- **Revoke:** `POST /key/delete` with `{"keys":["sk-..."]}`.
- **Inspect spend:** `GET /key/info?key=sk-...`.
- **Allowlist:** `models` restricts which models that key may call.

## 4. Dialect endpoints (used by clients in step 12)

LiteLLM exposes, on `https://api.domain.com`:

| Dialect | Path | Used by |
|---|---|---|
| OpenAI Chat Completions | `/v1/chat/completions` | Continue, opencode, JetBrains, most |
| OpenAI Responses | `/v1/responses` | Codex |
| Anthropic Messages | `/v1/messages` | Claude Code |

All authenticate with the same per-friend virtual key.

## Verification

```bash
curl -s http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <a-virtual-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"coder","messages":[{"role":"user","content":"say hi"}]}'
```

Returns a completion (after the cold-load on first hit). A bad/absent key returns
401 — confirming the gateway is enforcing auth.

→ Continue to [07 — Open WebUI](07-webui-open-webui.md).
