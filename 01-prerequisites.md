# 01 — Prerequisites

← [Back to README](README.md) · Next: [02 Host OS (Ubuntu)](02-host-os-ubuntu.md)

> **Overview:** Procure and configure everything needed before the main setup begins — hardware, accounts, domain, and the Cloudflare tunnel credential.
>
> **Why:** Being blocked mid-setup by a missing tunnel token, wrong hardware, or no domain is far more disruptive than resolving prerequisites first. This step is the pre-flight checklist.

## Accounts & domain

1. **Domain on Cloudflare.** Add your domain to Cloudflare and point your
   registrar's **nameservers** at Cloudflare. This is enough to use Tunnel/Access
   — a full registrar transfer can finish later (not a blocker). Confirm the zone
   is **Active** in the Cloudflare dashboard.
2. **Cloudflare Zero Trust.** Enable Zero Trust (free plan) on the account.
3. **Cloudflare Tunnel.** Zero Trust → Networks → Tunnels → **Create tunnel** →
   **Cloudflared** type → name it `home-llm` → **Save**. Cloudflare then shows an
   "install and run a connector" page with commands for Windows / macOS / Debian /
   Red Hat / Docker.
   > ⚠️ **Do not install or run a connector here.** Those commands are Cloudflare's
   > quick-start convenience — this stack runs the connector as a Kubernetes pod
   > instead ([step 04 §3](04-deploy-stack-ubuntu.md)). Copy **only the token** —
   > the long `eyJ…` string after `--token` — and save it to your **password
   > manager**. Then close the wizard; the named tunnel is saved and will show
   > **Inactive** until the k8s `cloudflared` pod connects in step 04.

   The token becomes the `cloudflared-credentials` Kubernetes Secret in
   [step 04](04-deploy-stack-ubuntu.md). Never commit it or run it anywhere.
   Public hostnames are added later in [step 08](08-connectivity-cloudflare.md).
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

### GPU options compared

This stack runs **EXL2 on ExLlamaV2** — effectively NVIDIA/CUDA only. For
single-stream coding/chat the felt speed is **memory-bandwidth bound** (each
token reads the whole active weights), so **VRAM capacity + bandwidth matter far
more than CUDA/tensor-core count**. Tensor cores mainly help prefill (long-context
ingestion) and multi-user batching.

Prices below are **Newegg new, lowest in-stock (June 2026)** — sealed/warrantied,
known provenance. They move weekly; re-check before buying.

| Build | New $ | Total VRAM | Bandwidth | NVLink | Power | Notes |
|---|---|---|---|---|---|---|
| **1× RTX 4090** | ~$3,400 | 24 GB | ~1.0 TB/s | n/a | ~450 W | Cheapest good single card; mature CUDA; the safe default |
| **1× RTX 5090** | ~$4,200 | 32 GB | **~1.8 TB/s** | n/a | ~575 W | Fastest + most VRAM on one card; **verify ExLlamaV2 builds on Blackwell first** |
| **2× RTX 4080 SUPER** | ~$2,600 | 32 GB | ~0.7 TB/s ea | **No** | ~640 W | Budget 32 GB, but layer-split over PCIe (no speedup), 2 slots |
| **2× RTX 3090** | ~$4,200 | **48 GB** | ~0.94 TB/s ea | **Yes** | ~700 W | Only sound multi-GPU path (NVLink → tensor-parallel); unlocks 70B-class. New 3090s are old-stock priced — value only if you catch FEs (~$1,699) |
| **2× RTX 3080** | ~$1,500 | 20 GB | ~0.76 TB/s ea | No | ~640 W | Cheapest, but 20 GB total is below the useful coding threshold; dominated by a single 4090 |

**How to choose:**

- **Default / lowest risk** → **1× RTX 4090.** 24 GB tier (step 10), proven, lowest
  power, no Blackwell-support risk.
- **Want speed + headroom** → **1× RTX 5090** for ~$800 more — 32 GB and ~1.8× the
  decode bandwidth lets you keep `coder` + `chat` resident. Confirm CUDA/ExLlamaV2
  wheels support Blackwell before committing.
- **Need 70B-class or several models hot at once** → **2× RTX 3090** (48 GB +
  NVLink). At new pricing this costs as much as a 5090, so only pick it for the
  capacity — otherwise the 5090 dominates it.
- **Skip** dual xx80/3080 unless budget is the hard cap: they reach (or miss)
  their VRAM total via PCIe layer-split with no NVLink — a worse path than a
  single card to the same capacity.

> GPU not bought yet? Continue with OS/storage/stack setup; you'll pull models
> and finalize tuning in [step 10](10-models.md) once the card is in.

## OS path (D8)

This guide uses **Ubuntu Server LTS** — plain Linux with
first-class NVIDIA driver support and no NAS overhead. Continue to
[step 02](02-host-os-ubuntu.md).
