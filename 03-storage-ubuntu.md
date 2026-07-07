# 03 — Fast model storage (Ubuntu)

← [02 Host OS](02-host-os-ubuntu.md) · Next: [04 Deploy stack](04-deploy-stack-ubuntu.md)

> **Overview:** Partition and persistently mount a dedicated NVMe SSD as `/srv/models`, separate from the OS disk, so model weights survive reboots and never compete with OS storage.
>
> **Why:** EXL2 model weights range from 10–100+ GB each. Keeping them on a separate NVMe protects the OS disk from exhaustion and gives full sequential read throughput during model loads — critical when swapping between models on a single GPU.

> ⚠️ **This step formats an entire drive.** Your OS lives on the boot NVMe (e.g.
> `nvme0n1`); running these commands against it will destroy your system. This
> step targets a **dedicated model-store NVMe**. Do **not** proceed until the new
> drive is installed and you have positively identified its device name (it will
> be `nvme1n1` or similar — **never** your boot disk).

## 1. Identify the NVMe device

```bash
lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,MODEL
```

The **new** drive is the one with **no partitions and no mountpoint** — likely
`/dev/nvme1n1`. `nvme0n1` (with `/`, `/boot`, and `/boot/efi` under it) is your
OS disk — never target it.

## 2. Partition and format

Set the target to the **new** drive and sanity-check it's empty before touching it:

```bash
NEW=/dev/nvme1n1          # ← the newly installed model-store NVMe (NOT nvme0n1)
lsblk "$NEW"              # confirm: correct size, NO partitions, NO mountpoints
[ "$NEW" = /dev/nvme0n1 ] && echo "REFUSING: that is the OS disk" && exit 1

sudo parted "$NEW" -- mklabel gpt
sudo parted "$NEW" -- mkpart primary ext4 0% 100%
sudo mkfs.ext4 "${NEW}p1"
```

## 3. Mount at `/srv/models`

```bash
sudo mkdir -p /srv/models

# Get the UUID of the new partition
sudo blkid "${NEW}p1"
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

## 4. Set ownership for model downloads

The inference pod mounts `/srv/models` **read-only** via a `hostPath` volume
([step 04](04-deploy-stack-ubuntu.md)); you download weights into it from the host
in [step 05](05-inference-tabbyapi-llamaswap.md). Give your admin user write access so those downloads
work:

```bash
sudo chown -R $USER:$USER /srv/models
```

## Verification

- `df -h /srv/models` shows the NVMe device with ample free space
  (aim for 500 GB–1 TB+).
- `ls /srv/models` succeeds as your non-root user.

The inference pod mounts `/srv/models` as `/models` (read-only `hostPath`); you
populate it from the host in [step 05](05-inference-tabbyapi-llamaswap.md).

→ Continue to [04 — Deploy stack](04-deploy-stack-ubuntu.md).
