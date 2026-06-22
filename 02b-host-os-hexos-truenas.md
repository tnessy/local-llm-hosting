# 02b — Host OS + GPU passthrough (HexOS / TrueNAS SCALE)

← [01 Prerequisites](01-prerequisites.md) · Next: [03b Storage (TrueNAS)](03b-storage-truenas.md) · Alt: [02a Unraid](02a-host-os-unraid.md)

HexOS is a management layer over **TrueNAS SCALE**, so GPU + Docker work happens
in the TrueNAS layer. Goal: OS installed and the NVIDIA GPU usable by containers.

## 1. Install TrueNAS SCALE / HexOS

1. Flash the TrueNAS SCALE (or HexOS) installer to a USB stick and boot from it.
2. Complete installation to the boot device; reboot.
3. Log in to the web UI; set a strong admin password.
4. Create your storage pool (detail in [step 03b](03b-storage-truenas.md)).

## 2. Install the NVIDIA driver

1. **Apps → Settings (or Configuration) → Install NVIDIA Drivers** — toggle it
   on. TrueNAS SCALE bundles the driver install; it downloads and activates.
2. Reboot if prompted.
3. Open a shell (**System Settings → Shell**, or SSH) and verify:

   ```bash
   nvidia-smi
   ```

   Confirm the GPU, driver, and VRAM appear. **Record the GPU UUID**
   (`GPU-xxxx-...`) if you want to pin a specific card later.

## 3. Confirm GPU is exposed to apps

Newer TrueNAS exposes GPUs to the Apps/Docker layer automatically once the driver
is installed. You'll confirm it's actually visible *inside* a container in
[step 04b](04b-deploy-stack-truenas.md) (running `nvidia-smi` in the container).

## 4. Enable custom app / compose deployment

TrueNAS SCALE runs apps on Docker. You'll deploy the stack as a **custom app
(YAML)** in [step 04b](04b-deploy-stack-truenas.md). If you prefer raw
`docker compose`, enable SSH (**System Settings → Services → SSH**) and use the
shell.

## Verification

- `nvidia-smi` lists the GPU on the host.
- The Apps service is running.
- SSH reachable (if you'll use the compose CLI path).

→ Continue to [03b — Storage (TrueNAS)](03b-storage-truenas.md).
