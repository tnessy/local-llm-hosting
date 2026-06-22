# 03b — Fast model storage (TrueNAS)

← [02b Host OS (HexOS/TrueNAS)](02b-host-os-hexos-truenas.md) · Next: [04b Deploy stack (TrueNAS)](04b-deploy-stack-truenas.md) · Alt: [03a Unraid](03a-storage-unraid.md)

EXL2 models load straight into VRAM — keep them on an **SSD pool** for fast swaps.

## 1. Create an SSD pool

1. **Storage → Create Pool** → name `nvme`.
2. Add your NVMe/SSD device(s). For a single drive a stripe is fine (no
   redundancy — it's just model files you can re-download); mirror if you have
   two and want resilience.

## 2. Create the model dataset

1. **Datasets → Add Dataset** under the `nvme` pool → name `models`.
2. Leave defaults (or set record size 1M for large sequential files).
3. The host path will be `/mnt/nvme/models`.

## 3. Note the path for the stack

In [step 04b](04b-deploy-stack-truenas.md) you'll map the project's `models`
volume to `/mnt/nvme/models` (host path) so TabbyAPI reads EXL2 weights from SSD.

## Verification

- The `models` dataset shows under the `nvme` pool.
- `ls /mnt/nvme/models` works from the shell; free space is ample
  (500 GB–1 TB+ recommended).

→ Continue to [04b — Deploy stack (TrueNAS)](04b-deploy-stack-truenas.md).
