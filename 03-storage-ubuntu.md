# 03 — Fast model storage (Ubuntu)

← [02 Host OS](02-host-os-ubuntu.md) · Next: [04 Deploy stack](04-deploy-stack-ubuntu.md)

EXL2 models load straight into VRAM — keep them on the **NVMe SSD**, not the OS
disk, so model swaps stay fast.

## 1. Identify the NVMe device

```bash
lsblk -o NAME,SIZE,TYPE,MOUNTPOINT
```

Your NVMe will appear as `/dev/nvme0n1` (or similar). Confirm it has no existing
mount point.

## 2. Partition and format

```bash
sudo parted /dev/nvme0n1 -- mklabel gpt
sudo parted /dev/nvme0n1 -- mkpart primary ext4 0% 100%
sudo mkfs.ext4 /dev/nvme0n1p1
```

## 3. Mount at `/srv/models`

```bash
sudo mkdir -p /srv/models

# Get the UUID of the new partition
sudo blkid /dev/nvme0n1p1
```

Add to `/etc/fstab` (replace `<UUID>` with the value from `blkid`):

```
UUID=<UUID>  /srv/models  ext4  defaults,noatime  0  2
```

Mount and verify:

```bash
sudo mount -a
df -h /srv/models
```

## 4. Give Docker write access

```bash
sudo chown -R $USER:$USER /srv/models
```

## Verification

- `df -h /srv/models` shows the NVMe device with ample free space
  (aim for 500 GB–1 TB+).
- `ls /srv/models` succeeds as your non-root user.

The compose stack will bind-mount `/srv/models` into the inference container.

→ Continue to [04 — Deploy stack](04-deploy-stack-ubuntu.md).
