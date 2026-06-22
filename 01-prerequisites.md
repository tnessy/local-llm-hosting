# 01 — Prerequisites

← [Back to README](README.md) · Next: [02a Unraid](02a-host-os-unraid.md) / [02b HexOS-TrueNAS](02b-host-os-hexos-truenas.md)

Do these before touching the server.

## Accounts & domain

1. **Domain on Cloudflare.** Add your domain to Cloudflare and point your
   registrar's **nameservers** at Cloudflare. This is enough to use Tunnel/Access
   — a full registrar transfer can finish later (not a blocker). Confirm the zone
   is **Active** in the Cloudflare dashboard.
2. **Cloudflare Zero Trust.** Enable Zero Trust (free plan) on the account.
3. **Cloudflare Tunnel.** Zero Trust → Networks → Tunnels → **Create tunnel** →
   name `home-llm` → choose the **Docker** connector → copy the token from the
   shown `--token <...>` command. Save it for `CF_TUNNEL_TOKEN` in `.env`.
   (You'll add the public hostnames in [step 08](08-connectivity-cloudflare.md).)
4. **Tailscale account.** Sign up (free Personal plan is fine) at tailscale.com.
   You'll install it on the server and your own devices in
   [step 09](09-connectivity-tailscale.md).

## Plan your two subdomains

- `llm.domain.com` → the chat UI (Open WebUI).
- `api.domain.com` → the API gateway (LiteLLM).

No DNS records needed yet — the tunnel creates them in step 08.

## Hardware checklist

| Component | Guidance |
|---|---|
| **GPU (NVIDIA)** | The one component that gates everything. See the VRAM tiers in [step 10](10-models.md). ExLlamaV2 shines on RTX 3090/4090/5090-class cards. |
| **System RAM** | ≥ VRAM, ideally 1.5–2× (32–64 GB). |
| **NVMe SSD** | 500 GB–1 TB+ for the EXL2 model store (models are large; they add up). Fast disk = faster model swaps. |
| **PSU** | Size for GPU TDP (≈350–450 W for 3090/4090) plus headroom. |
| **Cooling / noise** | Sustained inference runs hot; ensure real airflow. |
| **Network** | Gigabit LAN. Your **ISP upload** speed is the real remote bottleneck (light for text, heavier for images). |
| **UPS** | Optional but nice for a 24/7 box. |

> GPU not bought yet? Continue with OS/storage/stack setup; you'll pull models
> and finalize tuning in [step 10](10-models.md) once the card is in.

## Decide your OS path (D8)

You're trialing both. Pick which to set up first and follow the matching **a**
or **b** files in steps 02–04:

- **a) Unraid** — mature Nvidia-driver plugin + Compose workflow.
- **b) HexOS / TrueNAS SCALE** — same stack via docker-compose / custom app.

The stack (steps 05+) is identical afterward.
