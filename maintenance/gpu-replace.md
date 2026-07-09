# GPU — Replace / Upgrade / Add a card

← [Maintenance index](README.md) · Setup refs: [02 Host+GPU](../02-host-os-ubuntu.md) · [04 Deploy](../04-deploy-stack-ubuntu.md) · [05 Inference](../05-inference-tabbyapi-llamaswap.md)

> **Overview:** Swap the inference GPU (or add a second one) with a clean drain,
> a driver/device-plugin re-verification, and a config pass to actually use the
> new VRAM — then confirm end-to-end before calling it done.
>
> **Why a runbook:** a GPU swap touches four layers that fail independently — the
> **host driver**, the **MicroK8s device plugin**, the **model/quant/context
> config**, and **monitoring**. Doing them in order (and knowing the rollback)
> turns swap day into a 30-minute maintenance window instead of a debugging
> session while friends are asking why chat is down.

## Scenarios this covers

| Scenario | What changes | Extra sections |
|---|---|---|
| **Replace** | One card out, one card in (same slot) | core flow |
| **Upgrade** | Replace with a *bigger* card | core flow + §7 (exploit VRAM) |
| **Add** | Install an *additional* GPU (multi-GPU) | core flow + §8 (multi-GPU) |

> **Placeholders:** `<host>` (the server), `<node>` (its Kubernetes node name,
> from `microk8s kubectl get nodes`), `<new-gpu>` (the incoming card). Record the
> real models/drivers/configs for this run in `deployments/<host>.md`.

---

## 1. Pre-flight — capture the baseline (before touching anything)

You need a known-good reference to roll back to and to compare against.

```bash
# GPU model, driver, CUDA, VRAM — save the output
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
nvidia-smi   # note the CUDA version (top-right) and any resident processes

# What the cluster currently sees
microk8s kubectl get nodes -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}{"\n"}'
```

Also record: the current **model set / quant / context** you run (from your
`assets/llama-swap-config.yaml` and TabbyAPI configs — [step 05](../05-inference-tabbyapi-llamaswap.md)),
and your idle vs loaded `nvidia-smi` VRAM figures. Paste all of this into
`deployments/<host>.md` under a dated "GPU swap" note.

## 2. Pre-flight — driver & CUDA floor for the new card

A newer GPU often needs a newer driver than the one installed. **Check before you
open the case**, or you'll boot to a card the driver can't init:

- Look up the **minimum driver branch** for `<new-gpu>`. Rough guide: Ampere
  (30-series) and Ada (40-series) run on any current mainstream branch; **Blackwell
  (50-series) needs a recent branch + CUDA 12.8+**.
- If the installed driver predates that floor, plan a driver update as part of the
  swap ([step 02 §5](../02-host-os-ubuntu.md#5-install-the-nvidia-driver):
  `sudo ubuntu-drivers install`, or pin a specific branch).
- For **very new** architectures, confirm your **ExLlamaV3 / CUDA wheel** in the
  inference image supports it — a card the driver sees but the engine's CUDA
  kernels don't is a silent failure. Bump the image if needed.

> Driver updates are held back from unattended-upgrades on purpose ([step 02](../02-host-os-ubuntu.md)
> pins `nvidia-*`/`libnvidia-*`), so they only change when you do it here.

## 3. Pre-flight — power & physical budget

- **PSU headroom:** new card TDP + rest-of-system, with margin. A high-TDP card on
  a marginal PSU causes transient-load shutdowns under inference.
- **Power connectors:** provide the required 8-pin / **12VHPWR** cables from
  **separate PSU leads** — don't daisy-chain one cable to a 400 W+ card, and seat
  12VHPWR **fully** (partial seating is the connector-melt failure mode).
- **Adding a card:** confirm a second PCIe slot (x8 electrically is fine for
  inference), clearance/airflow between cards, and PSU for **both** under load.
- Announce the downtime, and confirm a **fresh backup** exists
  ([step 13](../13-operations.md) backup job).

## 4. Graceful drain (software, host still up)

Release the GPU cleanly so nothing is mid-request and VRAM is freed:

```bash
# Scale down every GPU consumer in llm-core (add comfyui/tabby if you did step 10)
microk8s kubectl -n llm-core scale deploy/inference --replicas=0
# microk8s kubectl -n llm-core scale deploy/comfyui --replicas=0
# microk8s kubectl -n llm-core scale deploy/tabby   --replicas=0

# Confirm no GPU processes remain, then it's safe to power down
nvidia-smi
sudo poweroff
```

## 5. Physical swap

Power off at the PSU and unplug. Anti-static precautions. Remove the old card
(keep it — it's your rollback until the new one is proven). Seat `<new-gpu>`
**fully** in the slot, connect power per §3. For an **add**, install alongside the
existing card. Reconnect and power on.

## 6. Post-swap verification (host → cluster → end-to-end)

**Host sees the card:**
```bash
lspci | grep -i nvidia                                   # new card enumerated
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
```
If `nvidia-smi` errors or shows a mismatch, the driver doesn't support the card →
update it ([step 02 §5](../02-host-os-ubuntu.md#5-install-the-nvidia-driver)),
reboot, re-check. Record the new baseline (name/driver/CUDA/VRAM).

**Cluster re-registered the GPU(s):**
```bash
microk8s kubectl get nodes -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}{"\n"}'
# Expect 1 (replace/upgrade) or your new total (add). May take a few minutes.
```
If it's stale or wrong, bounce the device plugin — restart the NVIDIA operator /
device-plugin pods in `gpu-operator-resources` (or `kube-system`), and only as a
last resort `microk8s disable gpu && microk8s enable gpu`.

**Bring inference back and confirm the pod sees the GPU:**
```bash
microk8s kubectl -n llm-core scale deploy/inference --replicas=1
microk8s kubectl -n llm-core rollout status deploy/inference
microk8s kubectl exec -n llm-core deploy/inference -- nvidia-smi   # new card, inside the pod
microk8s kubectl logs -f -n llm-core deploy/inference              # watch a model load
```

**End-to-end functional test** (the real "done" check):
- A chat via **Open WebUI** (UI path) **and** a call via **LiteLLM** (API path) —
  see [step 12](../12-verification.md).
- During a request, `nvidia-smi` shows VRAM in use; after the llama-swap `ttl`
  idle window it frees again ([step 05](../05-inference-tabbyapi-llamaswap.md)).

## 7. Exploit the new VRAM (the upgrade payoff)

A bigger card is wasted until you retune. This is where the value lands — see the
VRAM tiers and sizing guidance in [step 05](../05-inference-tabbyapi-llamaswap.md):

- **Raise quant (bpw) and/or context / KV-cache** to fill the new headroom (use
  `nvidia-smi` to size it — e.g. a larger context on a 24 GB card).
- **Fit a larger model class** or keep **more models resident** (revisit
  `assets/llama-swap-config.yaml` and the TabbyAPI model configs; re-tune `ttl`).
- Pull any new/larger weights you now have room for
  ([step 05](../05-inference-tabbyapi-llamaswap.md) download flow).
- Re-run the functional test after each config change; watch temps/power under a
  sustained load, not just a single prompt.

## 8. Multi-GPU (only when *adding* a card)

The device plugin now advertises `nvidia.com/gpu: N`. Decide the topology:

- **One big model across both** (tensor-parallel): set the inference pod request to
  `nvidia.com/gpu: 2` and configure ExLlamaV3 **`gpu_split` / tensor-parallel** in
  the TabbyAPI config. NVLink is optional for ExLlamaV3 tensor-parallel but helps;
  PCIe topology affects throughput. This is the path to **70B-class at good quant**
  (see [step 01 GPU options](../01-prerequisites.md#gpu-options-compared)).
- **Pin services to separate GPUs** (e.g. LLM on GPU 0, ComfyUI on GPU 1): give
  each pod `nvidia.com/gpu: 1` and constrain visibility with `CUDA_VISIBLE_DEVICES`
  (pin by the **GPU UUID** recorded in [step 02 §5](../02-host-os-ubuntu.md#5-install-the-nvidia-driver),
  not the index, which can reorder across boots). Removes the VRAM contention
  [step 10](../10-optional-comfyui-tabby.md) warns about.
- Recheck **power and thermals** under simultaneous dual-GPU load — this is the
  most common instability after an add.

## 9. Monitoring

- If you export GPU metrics (DCGM), confirm the new card/UUID reports and **adjust
  VRAM / temperature / power alert thresholds** to the new card's spec. (No GPU
  metrics yet? A swap is a natural time to add a DCGM exporter to the
  [step 13](../13-operations.md) monitoring stack — optional.)
- Sanity-check that the [step 02](../02-host-os-ubuntu.md) driver hold is still in
  place so the working driver isn't auto-bumped out from under you.

## 10. Rollback

If the new card won't init, the pod can't see it, or the system is unstable:

1. `microk8s kubectl -n llm-core scale deploy/inference --replicas=0` and power down.
2. Reinstall the **old card**; if you changed the driver, revert it to the branch
   recorded in §1.
3. Boot and re-verify against the §1 baseline (host `nvidia-smi`, cluster
   `nvidia.com/gpu`, pod `nvidia-smi`, a test chat).
4. Keep the old card on hand until the new one has run clean for a few days.

## 11. Document the result

Record in `deployments/<host>.md`: new GPU model + **UUID**, driver + CUDA
versions, the updated model/quant/context config, new idle/loaded VRAM figures,
PSU/power notes, and anything that surprised you (driver floor, connector, plugin
re-registration). That entry becomes the §1 baseline for the *next* swap.
