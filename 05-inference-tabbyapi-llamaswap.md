# 05 — Inference engine + models

← [04 Deploy stack](04-deploy-stack-ubuntu.md) · Next: [06 LiteLLM](06-gateway-litellm.md)

> **Overview:** The inference engine (llama-swap + TabbyAPI, running **ExLlamaV3**) is already deployed as a pod in [step 04](04-deploy-stack-ubuntu.md). Here you download **EXL3** model weights to `/srv/models`, wire them into the `llama-swap-config` ConfigMap with the right context window, and validate tool-calling.
>
> **Why:** Until real weights are on disk and named in the config, the engine runs but serves no model. Model choice, quant, and `--max-seq-len` here directly determine what fits in VRAM and whether local coding actually works.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<HF_TOKEN>` | HuggingFace access token (for gated models) | huggingface.co → Settings → Access Tokens |
> | `<org>/<model-exl3>` | HuggingFace repo of the EXL3 model | huggingface.co/models — search EXL3 variants |
> | `<local-folder-name>` | Folder under `/srv/models` for the weights | Your choice — referenced in `llama-swap-config.yaml` |

This is the engine layer (decisions **D3/D4**). **llama-swap** is the front door
on `:8080`; it launches a **TabbyAPI (ExLlamaV3)** process for whichever model a
request names, and unloads it when another model is needed — so a single GPU is
time-shared instead of contended.

Config files: [`assets/inference/Dockerfile`](assets/inference/Dockerfile) and
[`assets/llama-swap-config.yaml`](assets/llama-swap-config.yaml).

> **Format: EXL3 is the default.** New models use **EXL3 / ExLlamaV3** — newer
> model architectures (Gemma 4+) land there first, and EXL3's quality-per-bit beats
> EXL2 (a 14B fits 12 GB at ~4.0 bpw with ≈ EXL2-4.5 quality). **EXL2 still works** —
> TabbyAPI auto-detects the backend from the model folder, so the two formats
> coexist and existing EXL2 weights need no migration. Everything below applies to
> both; pick EXL3 when a quant is available.

## How it fits together

```
LiteLLM / Open WebUI ──► inference:8080  (llama-swap)
                              │  reads request's "model" field
                              ├─► starts TabbyAPI "coder" on :5001  (loads EXL3 → VRAM)
                              └─► starts TabbyAPI "chat"  on :5002
                          one model resident at a time (single GPU)
```

Each entry in [`llama-swap-config.yaml`](assets/llama-swap-config.yaml) maps a
**model name** (what clients request) to the **command** that starts its backend:

- `coder` → a coding model with function calling + large `--max-seq-len`.
- `chat` → a general chat model.

The `<placeholders>` (model filenames) are filled in below, once you've downloaded
EXL3 weights.

## 1. Pick models by VRAM

| VRAM | Coding model (EXL3, representative) | General chat | Notes |
|---|---|---|---|
| **24 GB** | Qwen3-Coder ~30B class | a 14–32B chat model | 256K-ctx capable; best responsiveness; room for a small 2nd model |
| **12–16 GB** | DeepSeek-Coder V3 distilled / ~14B | 7–14B chat | one model resident; moderate ctx |
| **8–10 GB** | 7–8B coder | 7–8B chat | single model; modest ctx; `ttl` matters |

Confirm exact current picks against a live leaderboard (e.g. Aider's) before
downloading — the field moves fast. Prefer a higher EXL3 bit-rate (≈4–5 bpw — EXL3
reaches EXL2 5–6 bpw quality at a lower bitrate) for coding if VRAM allows; code is
more quant-sensitive than chat.

### Current models — what fits this stack (June 2026)

This stack is **EXL3 / ExLlamaV3, GPU-resident** (no meaningful CPU offload; EXL2
also runs, auto-detected). That splits the current field cleanly into "runs locally
here" vs "cloud-route it." The frontier MoE models people search for (GLM-5.1,
DeepSeek-V4, Kimi, MiniMax-M3, MiMo, Qwen3.5-flagship) are **230 B–1.6 T
parameters** — they don't fit any consumer GPU at a usable quant, and most ship
**GGUF (llama.cpp)**, not EXL3.

| Model | Params (total/active) | Fits? | Min build | Notes |
|---|---|---|---|---|
| **Qwen3.5-27B** | 27 B dense | ✅ | 1× 4090 (24 GB) | ~16–20 GB @ 4–5 bpw; strong coder |
| **Qwen3.5-35B** | 35 B / 3 B (MoE) | ✅ | 1× 4090 (24 GB) | ~20–22 GB; 3 B active = fast decode |
| **Gemma 4 31B** | 31 B dense | ✅ | 1× 4090 (24 GB) | LiveCodeBench v6 ~80%; best local coder here |
| **GLM-5.1** | 754 B / 40 B (MoE) | ❌ | — | GGUF-only; see "frontier" below |
| **DeepSeek-V4** | Flash 284 B / Pro 1.6 T | ❌ | — | Even Flash busts 48 GB |

**Local picks (this stack):** Gemma 4 31B or Qwen3.5-27B on a single 24 GB card is
the sweet spot — none of the fitting models need more than a 4090. A 5090 (32 GB)
buys higher bit-rate + a 2nd model resident, not a bigger model tier.

**Frontier MoE (GLM-5.1 / DeepSeek-V4 / Kimi / MiniMax / MiMo):** not reachable on
this stack. Running one locally means **switching to llama.cpp/GGUF with
MoE CPU-offload** (1× 24 GB GPU **+ 256 GB system RAM**, single-digit tok/s), a
**256–512 GB Mac Ultra**, or a **multi-H200 cluster** — none interactive-grade for
the money. Instead, **route them through LiteLLM to a hosted API**
([step 06](06-gateway-litellm.md)) — clients don't change. Use local for the
fast/private 24 GB-tier coder, cloud for the frontier giants.

## 2. Download EXL3 weights to the model store

EXL3 models live as folders under the NVMe model dir from step 03 (`/srv/models`).

**Install the HuggingFace CLI on the host** — the `huggingface_hub` package
provides the `hf` command (the older `huggingface-cli` is deprecated). Install via
`pipx`, since Ubuntu blocks system-wide `pip install` (PEP 668), then log in with
your `<HF_TOKEN>` (needed for gated repos and to dodge anonymous rate limits):

```bash
sudo apt install -y pipx
pipx install huggingface_hub
pipx ensurepath   # then open a new shell (or: source ~/.bashrc)
hf auth login     # paste your <HF_TOKEN> when prompted
```

**Download the weights.** Some quantizers publish each bit-rate as a separate
branch, so add `--revision <bpw>` when the repo is organized that way:

```bash
hf download <org>/<model-exl3> --local-dir /srv/models/<local-folder-name>
```

The folder name is what you reference as `--model-name` in the config.

## 3. Wire the models into llama-swap

Edit [`assets/llama-swap-config.yaml`](assets/llama-swap-config.yaml): replace the
`<placeholders>` with your downloaded folder names. The engine reads this file
from the `llama-swap-config` ConfigMap, so push the edit to the ConfigMap and
restart the inference pod (editing the asset file alone has no effect on the
running pod):

```bash
microk8s kubectl create configmap llama-swap-config -n llm-core --from-file=llama-swap-config.yaml=assets/llama-swap-config.yaml --dry-run=client -o yaml | microk8s kubectl apply -f -
microk8s kubectl rollout restart deploy/inference -n llm-core
```

### Tuning knobs (set in the same file)

- **`--max-seq-len`** — the context window, and the **#1 setting** that makes local
  coding usable. Coding/agents flood context; too small silently truncates files
  and tool output and makes the model look "dumb." Higher = more VRAM for the KV
  cache. Size it up to what VRAM allows after the weights; watch
  `nvidia-smi` for KV-cache headroom (e.g. 32768–65536 on a 24 GB card).
- **`ttl`** (top of the YAML) — idle seconds before a model is unloaded to free
  VRAM. Raise it to avoid frequent cold starts; lower it to free the GPU sooner.
- **Keeping two models resident** — only if VRAM allows. Use a llama-swap
  **group** so `coder` and `chat` can be loaded together:

  ```yaml
  groups:
    both:
      - "coder"
      - "chat"
  ```

  On a single 24 GB card this usually means two *small* models; otherwise keep
  one-at-a-time (the default).

## 4. Cold-start and concurrency

- **Cold start:** the first request to a not-yet-loaded model waits ~5–30 s while
  EXL3 weights load into VRAM (depends on model size + NVMe speed). Subsequent
  requests are full speed until the model is swapped or times out (`ttl`). Expected
  — communicate it to UI friends (the dropdown switch has a brief pause).
- **Concurrency:** ExLlamaV3/TabbyAPI is fastest but oriented to **one request at a
  time**. llama-swap and LiteLLM queue concurrent hits. For a handful of friends
  who rarely fire simultaneously this is ideal. If you later need true concurrency,
  point a llama-swap entry at **vLLM** instead — no client changes (LiteLLM
  abstracts it). See the decisions log (D3/D4) to revisit.

## 5. Validate tool-calling

Local coding success hinges on reliable tool-calls. Validate in order:

1. **Aider** (most forgiving) — point it at the API (step 11), do a small
   multi-file edit. If this works, the model + context are sound.
2. **Continue** — confirm chat + autocomplete in the IDE.
3. Only then try heavier agents (Cline / OpenHands), which lean hardest on
   tool-calling.

If tool-calls are flaky: raise the EXL3 bit-rate, increase context, or switch to
a stronger coding model — all without touching client config (LiteLLM abstracts
the backend).

## 6. Token counts for metering (`usage`)

TabbyAPI computes token counts but only **includes** the OpenAI `usage` object in a
response when the request carries `stream_options: {include_usage: true}` — and,
unlike OpenAI, it applies that gate to **non-streaming** calls too. There is **no
server-side, CLI, or `config.yml` option** to change this; it is per-request only.
Omit the flag and every response comes back with `usage: null`, which LiteLLM
records as **0 tokens** — so the per-key budgets and rate limits in
[step 06](06-gateway-litellm.md) can't meter local models.

The fix lives in LiteLLM, not the engine: [`assets/litellm-config.yaml`](assets/litellm-config.yaml)
sets `extra_body.stream_options.include_usage: true` on each local model, so the
flag rides along on every LiteLLM → TabbyAPI request. `extra_body` is passed raw
upstream, so `drop_params: true` won't strip it. It's already enabled in this
repo's config — no action needed unless you add another local model, in which case
copy the `extra_body` block onto it.

> This applies to TabbyAPI-backed (local) models only. Hosted providers report
> `usage` natively.

## Verification

Test through LiteLLM from the host — that exercises the real client path
(LiteLLM → inference) and uses the host's `curl` (the `litellm` and `inference`
images ship none, so `kubectl exec … -- curl` fails). Leave a port-forward running
in one terminal:

```bash
microk8s kubectl port-forward -n llm-core svc/litellm 4000:4000
```

In another terminal, read the master key from the Secret and fire a completion —
the first request triggers the ~5–30 s cold load (watch
`microk8s kubectl logs -f -n llm-core deploy/inference` and `nvidia-smi`):

```bash
LITELLM_MASTER_KEY=$(microk8s kubectl get secret litellm-credentials -n llm-core -o jsonpath='{.data.master-key}' | base64 -d)
curl -s http://localhost:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" -d '{"model":"coder","messages":[{"role":"user","content":"say hi"}]}'
```

A completion means the model loaded and the full path works. (LiteLLM's
`/v1/models` only lists *configured* models, so it isn't proof the engine loaded —
the completion is.)

Pipe the response through `python3 -m json.tool` and confirm the `usage` block is
**populated** (`prompt_tokens`/`completion_tokens` > 0), not `null` — that verifies
the `extra_body` metering fix from §6 is in effect end-to-end. If `usage` is null,
the `stream_options.include_usage` flag isn't reaching TabbyAPI (check
`litellm-config.yaml`).

→ Continue to [06 — LiteLLM gateway](06-gateway-litellm.md).
