# 06 — Models

← [05 Inference](05-inference-tabbyapi-llamaswap.md) · Next: [07 LiteLLM](07-gateway-litellm.md)

> **Overview:** Download EXL2-quantized model weights to `/srv/models` via `huggingface-cli` and configure them in `llama-swap-config.yaml` with context window and max sequence length settings.
>
> **Why:** The inference engine serves no models until weights are on disk and wired into the llama-swap config. Context window and max sequence length settings here directly affect response quality and VRAM usage.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<HF_TOKEN>` | HuggingFace access token (required for gated models) | huggingface.co → Settings → Access Tokens |
> | `<org>/<model-exl2>` | HuggingFace repository path of the EXL2 model | huggingface.co/models — search EXL2 quantized variants |
> | `<local-folder-name>` | Folder name under `/srv/models` for the downloaded weights | Your choice — referenced in `llama-swap-config.yaml` |

## 1. Pick models by VRAM

| VRAM | Coding model (EXL2, representative) | General chat | Notes |
|---|---|---|---|
| **24 GB** | Qwen3-Coder ~30B class | a 14–32B chat model | 256K-ctx capable; best responsiveness; room for a small 2nd model |
| **12–16 GB** | DeepSeek-Coder V3 distilled / ~14B | 7–14B chat | one model resident; moderate ctx |
| **8–10 GB** | 7–8B coder | 7–8B chat | single model; modest ctx; `ttl` matters |

Confirm exact current picks against a live leaderboard (e.g. Aider's) before
downloading — the field moves fast. Prefer a higher EXL2 bit-rate (≈5–6 bpw) for
coding if VRAM allows; code is more quant-sensitive than chat.

### Current models — what fits this stack (June 2026)

This stack is **EXL2 / ExLlamaV2, GPU-resident** (no meaningful CPU offload). That
splits the current field cleanly into "runs locally here" vs "cloud-route it." The
frontier MoE models people search for (GLM-5.1, DeepSeek-V4, Kimi, MiniMax-M3,
MiMo, Qwen3.5-flagship) are **230 B–1.6 T parameters** — they don't fit any
consumer GPU at a usable quant, and most ship **GGUF (llama.cpp)**, not EXL2.

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
([step 07](07-gateway-litellm.md)) — clients don't change. Use local for the
fast/private 24 GB-tier coder, cloud for the frontier giants.

## 2. Download EXL2 weights to the model store

EXL2 models live as folders. Put them under the NVMe model dir from step 03
(`/srv/models`). With huggingface CLI on the host (or inside the container):

```bash
huggingface-cli download <org>/<model-exl2> --local-dir /srv/models/<Qwen3-Coder-30B-exl2>
```

The folder name is what you reference as `--model-name`.

## 3. Fill in llama-swap

Edit [`assets/llama-swap-config.yaml`](assets/llama-swap-config.yaml): replace the
`<placeholders>` with your downloaded folder names, and set `--max-seq-len` to a
**large** value your VRAM can hold (e.g. 32768–65536). The running engine reads
this file from the `llama-swap-config` ConfigMap, so push the edit to the
ConfigMap and restart the inference pod (editing the asset file alone has no
effect on the running pod):

```bash
microk8s kubectl create configmap llama-swap-config -n llm-core --from-file=llama-swap-config.yaml=assets/llama-swap-config.yaml --dry-run=client -o yaml | microk8s kubectl apply -f -
microk8s kubectl rollout restart deploy/inference -n llm-core
```

## 4. Set the context window deliberately

This is the single most important coding setting. Too small a context silently
truncates files/tool output and makes the model look "dumb." Size `--max-seq-len`
up to what VRAM allows after weights; watch `nvidia-smi` for KV-cache headroom.

## 5. Validate tool-calling

Local coding success hinges on reliable tool-calls. Validate in order:

1. **Aider** (most forgiving) — point it at the API (step 12), do a small
   multi-file edit. If this works, the model + context are sound.
2. **Continue** — confirm chat + autocomplete in the IDE.
3. Only then try heavier agents (Cline / OpenHands), which lean hardest on
   tool-calling.

If tool-calls are flaky: raise the EXL2 bit-rate, increase context, or switch to
a stronger coding model — all without touching client config (LiteLLM abstracts
the backend).

## Verification

```bash
microk8s kubectl exec -n llm-core deploy/litellm -- curl -s http://inference:8080/v1/models
```

Lists your real `coder`/`chat` models. A chat through Open WebUI and an Aider
edit both succeed.

→ Continue to [07 — LiteLLM gateway](07-gateway-litellm.md).
