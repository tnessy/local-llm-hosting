# 12 — Clients

← [11 Optional services](11-optional-comfyui-tabby.md) · Next: [13 Verification](13-verification.md)

How each persona connects. Two endpoints:

- **UI friends:** `https://llm.domain.com` (browser).
- **API friends:** `https://api.domain.com` + their **LiteLLM virtual key**
  (decision **D7**).

## Non-technical friend — Open WebUI

1. Open `https://llm.domain.com`.
2. Complete the Cloudflare login (Google or email code).
3. Log in to Open WebUI with the account you created (step 07).
4. Pick a model (`coder`/`chat`) and chat. First message after an idle period may
   pause briefly (model cold-load).

Nothing to install; works on mobile.

## Coder friend — recommended pair

### Continue (VS Code **and** JetBrains)

`config` (Continue's `config.yaml`/JSON), OpenAI-compatible:

```yaml
models:
  - name: coder (home)
    provider: openai
    model: coder
    apiBase: https://api.domain.com/v1
    apiKey: sk-<their-virtual-key>
```

Gives chat + inline autocomplete in the IDE.

### Aider (CLI/TUI) — best for local models

```bash
export OPENAI_API_BASE=https://api.domain.com/v1
export OPENAI_API_KEY=sk-<their-virtual-key>
aider --model openai/coder
```

## Other tools (all via the same key)

### opencode / Cline / JetBrains AI Assistant
Configure a **custom OpenAI-compatible provider**:
- Base URL `https://api.domain.com/v1`
- API key = virtual key
- Model `coder` or `chat`

### Codex (OpenAI Responses API)
`~/.codex/config.toml`:

```toml
model = "coder"
model_provider = "home"

[model_providers.home]
name = "Home LLM"
base_url = "https://api.domain.com/v1"
env_key = "HOME_LLM_KEY"     # export HOME_LLM_KEY=sk-<virtual-key>
wire_api = "responses"
# Optional CF service-token headers (if you enabled them in step 08):
# http_headers = { "CF-Access-Client-Id" = "...", "CF-Access-Client-Secret" = "..." }
```

### Claude Code (Anthropic Messages API)
```bash
export ANTHROPIC_BASE_URL=https://api.domain.com
export ANTHROPIC_AUTH_TOKEN=sk-<their-virtual-key>
export ANTHROPIC_DEFAULT_SONNET_MODEL=coder
claude
```

LiteLLM translates the Anthropic-format requests to the engine.

## Notes

- One key per friend → revoke/limit individually (step 06).
- GUI tools (JetBrains) can't send service-token headers — they rely on the
  bearer key + the API host's WAF rate limit. That's why `api.` uses Access
  **Bypass** (step 08).
- Switching backend models/engines never changes these client configs.

→ Continue to [13 — Verification](13-verification.md).
