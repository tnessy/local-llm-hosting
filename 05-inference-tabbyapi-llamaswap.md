# 05 — Inference: TabbyAPI + ExLlamaV2 + llama-swap

← [04 Deploy stack](04-deploy-stack-ubuntu.md) · Next: [06 Models](06-models.md)

> **Overview:** Configure the inference engine layer — llama-swap acts as the request router, launching a per-model TabbyAPI/ExLlamaV2 process on demand and unloading it when another model is requested.
>
> **Why:** A single GPU is time-shared across models via llama-swap rather than contended. Correct configuration here determines which models are available, how much VRAM each uses, and whether tool-calling functions correctly. Model file paths are filled in at step 06 once weights are downloaded.

This is the engine layer (decisions **D3/D4**). **llama-swap** is the front door
on `:8080`; it launches a **TabbyAPI/ExLlamaV2** process for whichever model a
request names, and unloads it when another model is needed — so a single GPU is
time-shared instead of contended.

Config files: [`assets/inference/Dockerfile`](assets/inference/Dockerfile) and
[`assets/llama-swap-config.yaml`](assets/llama-swap-config.yaml).

## How it fits together

```
LiteLLM / Open WebUI ──► inference:8080  (llama-swap)
                              │  reads request's "model" field
                              ├─► starts TabbyAPI "coder" on :5001  (loads EXL2 → VRAM)
                              └─► starts TabbyAPI "chat"  on :5002
                          one model resident at a time (single GPU)
```

## 1. Understand the model map

In [`llama-swap-config.yaml`](assets/llama-swap-config.yaml) each entry maps a
**model name** (what clients request) to the **command** that starts its backend:

- `coder` → a coding model with function calling + large `--max-seq-len`.
- `chat` → a general chat model.

The `<placeholders>` (model filenames) are filled in
[step 06](06-models.md) once you've downloaded EXL2 weights. Until then the
engine starts but has no model to load.

## 2. Tuning knobs

- **`--max-seq-len`** — the context window. Set it generously (coding/agents
  flood context). Higher = more VRAM for the KV cache. This is the #1 setting
  that makes local coding usable.
- **`ttl`** (top of the YAML) — idle seconds before a model is unloaded to free
  VRAM. Raise it to avoid frequent cold starts; lower it to free the GPU sooner.
- **Keeping two models loaded at once** — only if VRAM allows. Use a llama-swap
  **group** so `coder` and `chat` can be resident together:

  ```yaml
  groups:
    both:
      - "coder"
      - "chat"
  ```

  On a single 24 GB card this usually means two *small* models; otherwise keep
  one-at-a-time (the default).

## 3. Cold-start behavior

The first request to a not-yet-loaded model waits ~5–30 s while EXL2 weights load
into VRAM (depends on model size + NVMe speed). Subsequent requests are full
speed until the model is swapped or times out. This is expected — communicate it
to UI friends (the dropdown switch has a brief pause).

## 4. Concurrency note

ExLlamaV2/TabbyAPI is fastest but oriented to **one request at a time**.
llama-swap and LiteLLM queue concurrent hits. For a handful of friends who rarely
fire simultaneously this is ideal. If you later need true concurrency, you can
point a llama-swap entry at **vLLM** instead — no client changes (LiteLLM
abstracts it). See the decisions log (D3/D4) to revisit.

## Verification

After [step 06](06-models.md) fills in real models:

```bash
# from the server, exercise the internal endpoint via the litellm pod
microk8s kubectl exec -n llm-core deploy/litellm -- curl -s http://inference:8080/v1/models
```

You should see `coder` and `chat` listed. A first chat request triggers a cold
load (watch `microk8s kubectl logs -f -n llm-core deploy/inference`), then responds.

→ Continue to [06 — Models](06-models.md).
