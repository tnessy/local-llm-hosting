# 03a — Fast model storage (Unraid)

← [02a Host OS (Unraid)](02a-host-os-unraid.md) · Next: [04a Deploy stack (Unraid)](04a-deploy-stack-unraid.md) · Alt: [03b TrueNAS](03b-storage-truenas.md)

EXL2 models are large and load straight into VRAM — put them on **NVMe**, not the
spinning array, so model swaps are fast.

## 1. Create an NVMe cache pool

1. **Main → Pool Devices → Add Pool** → name it `nvme`.
2. Assign your NVMe SSD(s) to the pool.
3. Start the array; format the pool if prompted (XFS or BTRFS).

## 2. Create the model share

1. **Shares → Add Share** → name `models`.
2. Set **Primary storage** = `nvme` pool; set the share to stay on NVMe (no mover
   to array), e.g. Primary = `nvme`, Secondary = none.
3. The host path will be `/mnt/nvme/models` (or `/mnt/user/models`).

## 3. Note the path for the stack

The compose `models:` volume maps to this location. In
[step 04a](04a-deploy-stack-unraid.md) you'll point the project's `models`
volume at `/mnt/nvme/models`.

## Verification

- `ls /mnt/nvme/` shows the `models` share.
- `df -h /mnt/nvme` confirms it's the NVMe device with ample free space
  (aim for 500 GB–1 TB+).

→ Continue to [04a — Deploy stack (Unraid)](04a-deploy-stack-unraid.md).
