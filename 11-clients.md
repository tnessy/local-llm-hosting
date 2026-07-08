# 11 — Clients

← [10 Optional services](10-optional-comfyui-tabby.md) · Next: [12 Verification](12-verification.md)

> **Overview:** Connection reference for every client type — browser UI friends, direct API users, and AI coding tools (Aider, Codex, Claude Code). Covers the endpoint, key format, and tool-specific configuration for each persona.
>
> **Why:** Each client uses a different endpoint and auth mechanism. Handing out the wrong endpoint or key format is a common setup mistake; this step captures the exact connection details per persona before anyone is onboarded.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<api.domain.com>` | Public API hostname | Configured in step 09 |
> | `<their-virtual-key>` | Per-friend LiteLLM `sk-...` key | Minted in step 06 for each friend |

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

Gives chat + inline edits in the IDE. (Autocomplete needs a FIM model; a
chat-tuned `coder` won't do good FIM — leave it off or use Tabby, step 10.)

> **JetBrains alternative — ProxyAI** (marketplace, was "CodeGPT"): Continue is
> shifting focus to its CLI, so on JetBrains **ProxyAI** is often the smoother
> install. Settings → Tools → ProxyAI → Providers → **Custom OpenAI**: URL
> `https://api.domain.com/v1/chat/completions`, API key = virtual key, model `coder`.

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
# Optional CF service-token headers (if you enabled them in step 09):
# http_headers = { "CF-Access-Client-Id" = "...", "CF-Access-Client-Secret" = "..." }
```

### Claude Code (Anthropic Messages API)
```bash
export ANTHROPIC_BASE_URL=https://api.domain.com
export ANTHROPIC_AUTH_TOKEN=sk-<their-virtual-key>
export ANTHROPIC_DEFAULT_SONNET_MODEL=coder
export ANTHROPIC_DEFAULT_OPUS_MODEL=coder
export ANTHROPIC_DEFAULT_HAIKU_MODEL=coder    # map ALL tiers to one model — see note
claude
```

> ⚠️ **Claude Code only works cleanly against a _native Anthropic_ backend** — i.e.
> a hosted/frontier model routed through LiteLLM (D13, BYO key). It does **not**
> work against a **local OpenAI-compatible** engine (TabbyAPI/llama-swap): Claude
> Code hits `/v1/messages`, and LiteLLM's `/v1/messages`→OpenAI *translation* is
> experimental and currently drops Claude Code's `input_text` content blocks
> ([BerriAI/litellm#23841](https://github.com/BerriAI/litellm/issues/23841)) — you'll
> get a 404 / "model may not exist". For **local** models use **Aider** or a
> JetBrains/VS Code plugin (below), which speak OpenAI `/v1/chat/completions`.
>
> Also: in Claude Code's `/model` picker, avoid the **Default** entry — it appends a
> `[1m]` 1M-context suffix (`coder[1m]`) the backend won't recognize. Pick the
> explicit tier entry (`coder`), and map all three tiers to the **same** model name
> so llama-swap doesn't cold-swap between identical models.

## Notes

- One key per friend → revoke/limit individually (step 06).
- GUI tools (JetBrains) can't send service-token headers — they rely on the
  bearer key + the API host's WAF rate limit. That's why `api.` uses Access
  **Bypass** (step 09).
- Switching backend models/engines never changes these client configs.

→ Continue to [12 — Verification](12-verification.md).
