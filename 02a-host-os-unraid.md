# 02a — Host OS + GPU passthrough (Unraid)

← [01 Prerequisites](01-prerequisites.md) · Next: [03a Storage (Unraid)](03a-storage-unraid.md) · Alt: [02b HexOS/TrueNAS](02b-host-os-hexos-truenas.md)

Goal: Unraid installed and the NVIDIA GPU usable by Docker containers.

## 1. Install Unraid

1. Use the **Unraid USB Creator** to flash a USB stick; boot the server from it.
2. Complete first-boot setup at `http://tower.local` (or the server IP).
3. Assign disks and start the array (storage detail in
   [step 03a](03a-storage-unraid.md)).

## 2. Enable Docker & Community Apps

1. **Settings → Docker → Enable Docker = Yes**.
2. Install the **Community Apps** plugin (Apps tab) — this is the plugin store.

## 3. Install the NVIDIA driver

1. In **Apps**, search **"Nvidia Driver"** (by ich777) and install it.
2. Reboot if prompted.
3. Open a terminal (Unraid header → **Terminal** ▸) and verify:

   ```bash
   nvidia-smi
   ```

   You should see your GPU, driver, and VRAM. **Record the GPU UUID** (the
   `GPU-xxxxxxxx-...` value) — optional, used if you want to pin a specific card
   in `docker-compose.yml`.

## 4. Install Compose support

Install **"Docker Compose Manager"** (by dcflachs) from Community Apps. You'll
use it to bring up the stack in [step 04a](04a-deploy-stack-unraid.md).

## Verification

- `nvidia-smi` lists the GPU.
- Docker is enabled (Docker tab loads).
- Compose Manager appears under **Settings**.

→ Continue to [03a — Storage (Unraid)](03a-storage-unraid.md).
