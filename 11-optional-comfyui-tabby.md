# 11 — Optional: ComfyUI (Stable Diffusion) + Tabby (autocomplete)

← [10 Models](10-models.md) · Next: [12 Clients](12-clients.md)

> **Overview:** Optionally add ComfyUI (Stable Diffusion) and/or Tabby ML (code autocomplete) as additional Docker Compose services that share the same GPU as the inference stack.
>
> **Why:** Both services reuse the existing Docker network and NVIDIA runtime with no firewall changes. The main constraint is VRAM contention — the LLM engine must be unloaded for either service to use the GPU simultaneously.

Optional sibling services (decision **D10**). Both share the **one GPU** with the
LLM engine — mind VRAM contention (see the caution at the end).

Both are pre-written but **commented out** in
[`assets/docker-compose.yml`](assets/docker-compose.yml); uncomment what you want.

## ComfyUI — Stable Diffusion

Why ComfyUI: its **queue + WebSocket** API sidesteps Cloudflare's ~100 s timeout
(unlike a single blocking HTTP generate call).

1. Uncomment the `comfyui` service and the `comfyui-data` volume in compose.
2. `docker compose up -d comfyui`.
3. Expose it to friends (optional): add a tunnel route
   `sd.domain.com → http://comfyui:8188` and an **Access** policy (same allowlist
   as the UI) in [step 08](08-connectivity-cloudflare.md).
4. Integrate into chat (optional): Open WebUI → Admin → Settings → **Images** →
   engine ComfyUI, base URL `http://comfyui:8188`. UI friends generate images
   from chat.

## Tabby — self-hosted code autocomplete

A Copilot-style FIM completion server for the IDE.

1. Uncomment the `tabby` service and `tabby-data` volume.
2. `docker compose up -d tabby`.
3. Point the Tabby IDE plugin (VS Code/JetBrains) at it over Tailscale, or add a
   tunnel route + Access policy if a remote friend needs it.

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

- ComfyUI UI loads (locally `http://localhost:8188` via Tailscale); a test
  generation completes.
- Tabby `/v1/health` responds; IDE shows inline completions.

→ Continue to [12 — Clients](12-clients.md).
