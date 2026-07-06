# 02 — Host OS + GPU (Ubuntu Server 26.04 LTS)

← [01 Prerequisites](01-prerequisites.md) · Next: [03 Storage](03-storage-ubuntu.md)

> **Overview:** Install Ubuntu Server 24.04 LTS, establish the security baseline (timezone, automatic security patches, SSH hardening, UFW firewall), install Docker as an image builder, and install the NVIDIA driver + Container Toolkit so the GPU is available to the MicroK8s cluster.
>
> **Why:** Every layer above — MicroK8s, LiteLLM, Open WebUI — runs on top of this OS configuration. Firewall rules and automatic patching set here are significantly harder to retrofit once the stack is running.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<your/timezone>` | IANA timezone string (e.g. `America/New_York`, `Europe/London`) | `timedatectl list-timezones` |
> | `<your-user>` | Admin Linux username on the server | Chosen during Ubuntu install |
> | `<server-lan-ip>` | Server's static LAN IPv4 address | Router DHCP reservation, or `ip addr` after first boot |
> | `<LAN_CIDR>` | Local subnet in CIDR notation (e.g. `192.168.1.0/24`) | Router admin UI |
> | `<GRAFANA_HOST_IP>` | LAN IP of the Grafana/Prometheus host (step 14 monitoring) | Fill in when step 14 monitoring is configured — leave the UFW rule commented out until then |

> **Locked values for this server (`surtr`)** — baked into the commands below:
>
> | Placeholder | Value |
> |---|---|
> | `<your-user>` | `nss` |
> | `<your/timezone>` | `America/New_York` |
> | `<server-lan-ip>` | `192.168.68.55` (DHCP reservation by MAC on the router) |
> | `<LAN_CIDR>` | `192.168.64.0/19` (derived from `192.168.68.55/19`) |
> | `<GRAFANA_HOST_IP>` | _deferred to step 14_ |

## 1. Install Ubuntu Server 26.04 LTS

> ✅ **Completed on `surtr`.** Ubuntu Server 26.04 LTS is installed with LVM on
> `nvme0n1`. Note the installer allocated only a **100 GB root LV**, leaving
> ~1.7 TB unallocated in `ubuntu-vg`; the model store goes on a **dedicated
> NVMe being added** — see [step 03](03-storage-ubuntu.md). Reference steps below.

1. Download the **Ubuntu Server 26.04 LTS** ISO and flash it to a USB stick
   (e.g. with `dd` or Balena Etcher).
2. Boot the server from the USB stick.
3. Accept defaults (no GUI, no snaps beyond the installer). When prompted:
   - Enable **OpenSSH server**.
   - Use LVM for the OS disk (keeps the NVMe for models separate — see
     [step 03](03-storage-ubuntu.md)).
4. Reboot, log in over SSH.

## 2. Update the system

**Set the system timezone first** — `unattended-upgrades` schedules automatic
reboots using the system clock; set the correct timezone before configuring it.

```bash
# List available timezones: timedatectl list-timezones | grep <Region>
sudo timedatectl set-timezone America/New_York
timedatectl   # verify
```

Apply all pending updates and reboot:

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

**Enable automatic security updates:**

```bash
sudo apt install -y unattended-upgrades

sudo tee /etc/apt/apt.conf.d/50unattended-upgrades > /dev/null <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

// NVIDIA driver updates can break GPU container access — apply manually and verify.
Unattended-Upgrade::Package-Blacklist {
    "nvidia-*";
    "libnvidia-*";
};

// Reboot time uses the system timezone set above. Adjust for your low-traffic window.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";

Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
EOF

sudo tee /etc/apt/apt.conf.d/20auto-upgrades > /dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# Verify the configuration and preview what would be updated
sudo unattended-upgrades --dry-run --debug 2>&1 | grep -E "Packages|No packages|Considering"
```

> **Monitoring dependency:** Post-reboot health visibility depends on logs being
> shipped to Loki before shutdown completes. When implementing step 14 (H-29),
> configure the Promtail systemd unit with `TimeoutStopSec=30` so it flushes its
> buffer before the reboot, and add a Grafana heartbeat alert that fires if the
> LLM server stops sending logs for more than 5–10 minutes.

## 3. Harden SSH

Ubuntu enables OpenSSH with password authentication on by default. Lock it
down before proceeding.

**Phase approach — complete in order:**

**Phase 1 — Confirm key-based login works** (before disabling password auth):

```bash
# On your admin machine: copy your public key to the server
ssh-copy-id nss@192.168.68.55

# Then verify you can log in without a password prompt
ssh nss@192.168.68.55
```

**Phase 2 — Apply hardened settings:**

```
# /etc/ssh/sshd_config — add or override these lines
PermitRootLogin no
PasswordAuthentication no
```

```bash
sudo sshd -t                  # validate config syntax
sudo systemctl restart ssh

# Verify: key login still works; password login is now rejected
ssh nss@192.168.68.55
```

> `PasswordAuthentication no` only controls SSH logins. `sudo` uses your
> Linux account password and is completely unaffected.

**Phase 3 — Onboarding a new SSH user (temporary per-user override):**

When adding a new user who hasn't yet set up their key, add a temporary
override so they can log in with a password and add their public key:

```
# /etc/ssh/sshd_config — add temporarily, remove once key is confirmed
#
# Match User <username>
#     PasswordAuthentication yes
```

Once they've added their public key to `~/.ssh/authorized_keys`, remove
the `Match` block and restart SSH — they're key-only from that point on.

> Interface binding (restricting which IPs SSH listens on) is configured in
> [step 09](09-connectivity-tailscale.md) once your Tailscale IP is known.

## 4. Configure the host firewall (UFW)

Ubuntu ships with UFW inactive. Enable it now — it blocks uninvited inbound
connections from LAN devices and from any future public IPv6 address your ISP
assigns (IPv6 bypasses NAT; without a host firewall the server would be directly
internet-facing on IPv6).

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH from your local network. sshd's ListenAddress (step 09 §4) also restricts
# which interfaces sshd binds to; UFW is the independent network-layer backstop.
# LAN subnet for surtr (derived from 192.168.68.55/19)
sudo ufw allow from 192.168.64.0/19 to any port 22 proto tcp

# ── Monitoring placeholder (step 14) ──────────────────────────────────────────
# Promtail pushes logs outbound to Loki — no inbound rule needed.
# Prometheus pulls metrics inbound. Once your Grafana host's LAN IP is known,
# uncomment and fill in:
#   sudo ufw allow from <GRAFANA_HOST_IP> to any port 9100 comment "node-exporter"
#   sudo ufw allow from <GRAFANA_HOST_IP> to any port 30000:32767 comment "k8s NodePorts (metrics)"
# ─────────────────────────────────────────────────────────────────────────────

sudo ufw enable
```

Verify:

```bash
sudo ufw status verbose
```

The Tailscale interface rule (`ufw allow in on tailscale0`) is added in
[step 09 §1](09-connectivity-tailscale.md) once Tailscale is running.

> **Docker and UFW:** Docker can insert iptables rules that bypass UFW for
> published `ports:` bindings — but here Docker is only an image builder and runs
> **no containers**, so it publishes no ports. The core stack is MicroK8s, whose
> Services are ClusterIP (no host ports) reached via the outbound tunnel; any
> NodePort exception (e.g. Trivy metrics, step 14) gets an explicit UFW rule.

## 5. Install the NVIDIA driver

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
(`GPU-xxxxxxxx-...`) — optional, useful on a multi-GPU host to pin a specific
card.

## 6. Install Docker Engine

> **Docker here is only an image builder.** The stack runs as MicroK8s pods
> (step 04), not Docker containers. Docker is used solely to `docker build` the
> inference image (and later the workspace/admin-ui images) and push them to the
> MicroK8s registry.

> ✅ **Docker already installed on `surtr`** — Docker Engine 29.6.1. Skip the
> repo/install block below.

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
sudo apt install -y docker-ce docker-ce-cli containerd.io
```

> **No one joins the `docker` group.** Membership is equivalent to passwordless
> root — any member can `docker run -v /:/host` and escape to a host root shell.
> Since the admin account already uses `sudo` throughout this guide, run image
> builds as `sudo docker build …` (step 04 §5). No dedicated Docker service
> account is needed now that the stack runs in Kubernetes.

## 7. Install the NVIDIA Container Toolkit

The GPU is consumed by the MicroK8s cluster, not by Docker. MicroK8s's `gpu`
add-on ([step 04 §1](04-deploy-stack-ubuntu.md)) configures its own containerd
runtime for GPU access; this section only installs the host-level toolkit and
verifies the host driver.

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update
sudo apt install -y nvidia-container-toolkit
```

> No `nvidia-ctk runtime configure --runtime=docker` is needed — the stack runs
> no GPU workloads under Docker. GPU-in-cluster is configured and verified later:
> `microk8s enable gpu` (step 04 §1) and `kubectl exec … nvidia-smi` (step 04 §9).

## Verification

```bash
# GPU visible on the host (driver working)
nvidia-smi
```

Lists the GPU, driver version, and VRAM. GPU visibility **inside the cluster** is
verified in [step 04 §9](04-deploy-stack-ubuntu.md) once MicroK8s is running.

→ Continue to [03 — Storage](03-storage-ubuntu.md).
