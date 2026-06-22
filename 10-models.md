# 10 — Models

← [09 Tailscale](09-connectivity-tailscale.md) · Next: [11 Optional services](11-optional-comfyui-tabby.md)

Do this once the GPU is in (decision **D9**). You'll download **EXL2** quants,
wire them into llama-swap, set the context window, and validate tool-calling.

## 1. Pick models by VRAM

| VRAM | Coding model (EXL2, representative) | General chat | Notes |
|---|---|---|---|
| **24 GB** | Qwen3-Coder ~30B class | a 14–32B chat model | 256K-ctx capable; best responsiveness; room for a small 2nd model |
| **12–16 GB** | DeepSeek-Coder V3 distilled / ~14B | 7–14B chat | one model resident; moderate ctx |
| **8–10 GB** | 7–8B coder | 7–8B chat | single model; modest ctx; `ttl` matters |

Confirm exact current picks against a live leaderboard (e.g. Aider's) before
downloading — the field moves fast. Prefer a higher EXL2 bit-rate (≈5–6 bpw) for
coding if VRAM allows; code is more quant-sensitive than chat.

## 2. Download EXL2 weights to the model store

EXL2 models live as folders. Put them under the NVMe model dir from step 03
(`/mnt/nvme/models`). With huggingface CLI on the host (or inside the container):

```bash
huggingface-cli download <org>/<model-exl2> \
  --local-dir /mnt/nvme/models/<Qwen3-Coder-30B-exl2>
```

The folder name is what you reference as `--model-name`.

## 3. Fill in llama-swap

Edit [`assets/llama-swap-config.yaml`](assets/llama-swap-config.yaml): replace the
`<placeholders>` with your downloaded folder names, and set `--max-seq-len` to a
**large** value your VRAM can hold (e.g. 32768–65536). Then restart:

```bash
docker compose restart inference
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
docker exec -it litellm sh -c 'curl -s http://inference:8080/v1/models'
```

Lists your real `coder`/`chat` models. A chat through Open WebUI and an Aider
edit both succeed.

→ Continue to [11 — Optional: ComfyUI + Tabby](11-optional-comfyui-tabby.md).
