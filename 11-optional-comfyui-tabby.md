# 11 — Optional: ComfyUI (Stable Diffusion) + Tabby (autocomplete)

← [10 Models](10-models.md) · Next: [12 Clients](12-clients.md)

> **Overview:** Optionally add ComfyUI (Stable Diffusion) and/or Tabby ML (code autocomplete) as additional k8s Deployments in `llm-core` that share the same GPU as the inference engine.
>
> **Why:** Both reuse the cluster's NVIDIA device plugin and in-cluster networking with no firewall changes. The main constraint is VRAM contention — the LLM engine and either service compete for the single GPU.

Optional sibling services (decision **D10**). Both share the **one GPU** with the
LLM engine — mind VRAM contention (see the caution at the end).

Each is a self-contained manifest under
[`assets/k8s/llm-core/`](assets/k8s/llm-core/) (Deployment + Service + PVC +
NetworkPolicy). Apply only what you want.

## ComfyUI — Stable Diffusion

Why ComfyUI: its **queue + WebSocket** API sidesteps Cloudflare's ~100 s timeout
(unlike a single blocking HTTP generate call).

1. Deploy it:
   ```bash
   microk8s kubectl apply -f assets/k8s/llm-core/comfyui.yaml
   ```
2. Integrate into chat: Open WebUI → Admin → Settings → **Images** → engine
   ComfyUI, base URL `http://comfyui.llm-core:8188`. UI friends generate images
   from chat (the `comfyui-policy` already allows open-webui → comfyui).
3. Expose it to friends (optional, advanced): add an `sd.` listener to the
   `core-gateway` and an HTTPRoute to the `comfyui` Service, then a
   `sd.domain.com → http://traefik.llm-platform:80` tunnel route + **Access**
   policy in [step 08](08-connectivity-cloudflare.md).

## Tabby — self-hosted code autocomplete

A Copilot-style FIM completion server for the IDE.

1. Deploy it:
   ```bash
   microk8s kubectl apply -f assets/k8s/llm-core/tabby.yaml
   ```
2. Reach the Tabby IDE plugin (VS Code/JetBrains) at it via
   `microk8s kubectl port-forward -n llm-core svc/tabby 8080:8080` over Tailscale,
   or add a Gateway listener + HTTPRoute + tunnel route if a remote friend needs it.

> Continue (step 12) also does autocomplete against your main models, so Tabby is
> only worth it if you want a dedicated, always-on completion model.

## ⚠️ VRAM contention

SD and the LLM both want the GPU:

- Heavy SD (SDXL, Flux) wants **8–16 GB+** on its own. Running it *and* a large
  LLM concurrently on one 24 GB card will be slow or OOM.
- Options: accept contention (fine for occasional use), keep SD models small, set
  llama-swap `ttl` low so the LLM frees VRAM when idle, or add a **second GPU**
  dedicated to images.
- If image gen is a primary use, plan VRAM (and possibly a 2nd card) up front.

## Verification

- ComfyUI UI loads via `microk8s kubectl port-forward -n llm-core svc/comfyui 8188:8188`
  then `http://localhost:8188`; a test generation completes.
- Tabby `/v1/health` responds (through its port-forward); IDE shows inline completions.

→ Continue to [12 — Clients](12-clients.md).
