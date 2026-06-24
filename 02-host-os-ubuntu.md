# 02 — Host OS + GPU (Ubuntu Server 24.04 LTS)

← [01 Prerequisites](01-prerequisites.md) · Next: [03 Storage](03-storage-ubuntu.md)

Goal: Ubuntu installed, NVIDIA driver active, GPU visible to Docker containers.

## 1. Install Ubuntu Server 24.04 LTS

1. Download the **Ubuntu Server 24.04 LTS** ISO and flash it to a USB stick
   (e.g. with `dd` or Balena Etcher).
2. Boot the server from the USB stick.
3. Accept defaults (no GUI, no snaps beyond the installer). When prompted:
   - Enable **OpenSSH server**.
   - Use LVM for the OS disk (keeps the NVMe for models separate — see
     [step 03](03-storage-ubuntu.md)).
4. Reboot, log in over SSH.

## 2. Update the system

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

## 3. Install the NVIDIA driver

Ubuntu's `ubuntu-drivers` tool picks the right driver version automatically:

```bash
sudo apt install -y ubuntu-drivers-common
sudo ubuntu-drivers install
sudo reboot
```

After reboot, verify:

```bash
nvidia-smi
```

You should see your GPU, driver version, and VRAM. **Record the GPU UUID**
(`GPU-xxxxxxxx-...`) — optional, used if you want to pin a specific card in
`docker-compose.yml`.

## 4. Install Docker Engine

```bash
# Add Docker's official apt repo
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow your user to run docker without sudo
sudo usermod -aG docker $USER
newgrp docker
```

## 5. Install the NVIDIA Container Toolkit

This lets containers access the GPU via `docker run --gpus`:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

## Verification

```bash
# GPU visible on host
nvidia-smi

# GPU visible inside a container
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

Both should list the GPU and VRAM.

→ Continue to [03 — Storage](03-storage-ubuntu.md).
