# 02 — Host OS + GPU (Ubuntu Server LTS)

← [01 Prerequisites](01-prerequisites.md) · Next: [03 Storage](03-storage-ubuntu.md)

> **Overview:** Install the current Ubuntu Server LTS, establish the security baseline (timezone, automatic security patches, SSH hardening, UFW firewall), install Docker as an image builder, and install the NVIDIA driver + Container Toolkit so the GPU is available to the MicroK8s cluster.
>
> **Why:** Every layer above — MicroK8s, LiteLLM, Open WebUI — runs on top of this OS configuration. Firewall rules and automatic patching set here are significantly harder to retrofit once the stack is running.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<your/timezone>` | IANA timezone — **defaults to `Etc/UTC`**; override only for local time | `timedatectl list-timezones` |
> | `<your-user>` | Admin Linux username on the server | Chosen during Ubuntu install |
> | `<server-lan-ip>` | Server's static LAN IPv4 address | Router DHCP reservation, or `ip addr` after first boot |
> | `<LAN_CIDR>` | Local subnet in CIDR notation (e.g. `192.168.1.0/24`) | Router admin UI |
> | `<GRAFANA_HOST_IP>` | LAN IP of the Grafana/Prometheus host (step 13 monitoring) | Fill in when step 13 monitoring is configured — leave the UFW rule commented out until then |

## 1. Install Ubuntu Server (LTS)

1. Download the latest **Ubuntu Server LTS** ISO and flash it to a USB stick
   (e.g. with `dd` or Balena Etcher).
2. Boot the server from the USB stick.
3. Accept defaults (no GUI, no snaps beyond the installer). When prompted:
   - Enable **OpenSSH server**.
   - Use LVM for the OS disk (keeps the NVMe for models separate — see
     [step 03](03-storage-ubuntu.md)).
4. Reboot, log in over SSH.

### Record your system configuration

Once the system is up, capture its hardware, OS, storage, and network into a
**per-deployment companion doc** (e.g. `deployments/<host>.md` — git-ignored; see
the note in the [README](README.md)). You'll substitute these values into the
`<placeholders>` throughout this and later steps, so record them once now:

```bash
{
echo "### HOST";     hostnamectl 2>/dev/null | grep -E 'hostname|Operating System|Kernel|Architecture'
echo "### USER";     whoami
echo "### OS";       . /etc/os-release; echo "$PRETTY_NAME  (codename: $VERSION_CODENAME)"
echo "### TIMEZONE"; timedatectl show -p Timezone --value
echo "### CPU";      lscpu | grep -E 'Model name|^CPU\(s\)|Thread\(s\) per core|Core\(s\) per socket'
echo "### RAM";      free -h | awk '/Mem:/{print $2" total"}'
echo "### GPU";      nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null || lspci | grep -iE 'vga|3d controller'
echo "### DISKS";    lsblk -d -o NAME,SIZE,MODEL,TYPE | grep -vE 'loop|rom'
echo "### MOUNTS";   lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT | grep -vE 'loop'
echo "### LVM";      sudo vgs 2>/dev/null; sudo lvs -o lv_name,vg_name,lv_size 2>/dev/null
echo "### NETWORK";  ip -4 -o addr show scope global | awk '{print "addr:",$2,$4}'; ip -o -4 route show scope link | awk '{print "subnet:",$1,"dev",$3}'; ip route | awk '/default/{print "gateway:",$3,"dev",$5}'
echo "### DOCKER";   docker --version 2>/dev/null || echo "not installed"
} 2>&1 | tee ~/system-config.txt
```

Paste the output (also saved to `~/system-config.txt`) into your deployment doc.
It gives you the values behind the placeholders below — `<your-user>` (USER),
`<your/timezone>` (TIMEZONE), `<server-lan-ip>` + `<LAN_CIDR>` (NETWORK) — and the
disk/boot layout you'll need to identify the model-store drive in
[step 03](03-storage-ubuntu.md).

## 2. Update the system

**Set the system timezone first** — `unattended-upgrades` schedules automatic
reboots using the system clock, so set the timezone before configuring it. This
guide defaults to **UTC** — simplest for a server: no daylight-saving shifts, and
logs line up across machines. Override only if you have a reason to prefer local
time.

```bash
sudo timedatectl set-timezone Etc/UTC
# Prefer local time? e.g. sudo timedatectl set-timezone America/New_York
# List zones with: timedatectl list-timezones
timedatectl   # verify
```

Apply all pending updates and reboot:

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

**Enable automatic security updates.** `unattended-upgrades` ships preinstalled on
Ubuntu Server; this just confirms it's present:

```bash
sudo apt install -y unattended-upgrades
```

Open the main config in an editor and **replace its contents** (clear the default
lines, paste the block below):

```bash
sudo nano /etc/apt/apt.conf.d/50unattended-upgrades
```

```
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

// Reboot time uses the system timezone (UTC by default). Adjust for your low-traffic window.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";

Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
```

Then open the periodic-schedule config and paste the two lines:

```bash
sudo nano /etc/apt/apt.conf.d/20auto-upgrades
```

```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

Verify the configuration and preview what would be updated:

```bash
sudo unattended-upgrades --dry-run --debug 2>&1 | grep -E "Packages|No packages|Considering"
```

> **Monitoring dependency:** Post-reboot health visibility depends on logs being
> shipped to Loki before shutdown completes. When implementing step 13 (H-29),
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
ssh-copy-id <your-user>@<server-lan-ip>

# Then verify you can log in without a password prompt
ssh <your-user>@<server-lan-ip>
```

**Phase 2 — Apply hardened settings.**

> **Don't edit the main `sshd_config` — use a drop-in.** On modern Ubuntu,
> cloud-init writes `/etc/ssh/sshd_config.d/50-cloud-init.conf` (usually with
> `PasswordAuthentication yes`), and `Include`d drop-ins are read **first**. sshd
> uses the *first* value it sees for each keyword, so an edit in the main file is
> silently overridden. The reliable fix is a drop-in that sorts **before**
> cloud-init's — a `00-` prefix:

```bash
sudo nano /etc/ssh/sshd_config.d/00-hardening.conf
```

Paste:

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Verify the **effective** config (not just syntax) and restart:

```bash
sudo sshd -t
sudo sshd -T | grep -Ei 'passwordauthentication|permitrootlogin|kbdinteractive'
# All three must report "no". If not, another drop-in in
# /etc/ssh/sshd_config.d/ sorts before this one — lower its number or fix it there.

sudo systemctl restart ssh
```

Keep your current SSH session open, and confirm a **new** login works in a
separate terminal before closing it — key login still works, password login is
now rejected:

```bash
ssh <your-user>@<server-lan-ip>
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
> [step 08](08-connectivity-tailscale.md) once your Tailscale IP is known.

## 4. Configure the host firewall (UFW)

Ubuntu ships with UFW inactive. Enable it now — it blocks uninvited inbound
connections from LAN devices and from any future public IPv6 address your ISP
assigns (IPv6 bypasses NAT; without a host firewall the server would be directly
internet-facing on IPv6).

```bash
# Find your LAN subnet in CIDR form — the kernel already knows it (the connected
# route on your primary NIC). The first field is your <LAN_CIDR>:
ip -o -4 route show scope link | awk '{print $1, "dev", $3}'
# e.g. "192.168.1.0/24 dev eth0" (a common home default) — but yours may differ
# (e.g. a /19 subnet). Use the entry on the NIC that carries your default route.
```

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH from your local network. sshd's ListenAddress (step 08 §4) also restricts
# which interfaces sshd binds to; UFW is the independent network-layer backstop.
# Replace <LAN_CIDR> with the subnet found above.
sudo ufw allow from <LAN_CIDR> to any port 22 proto tcp

# ── Monitoring placeholder (step 13) ──────────────────────────────────────────
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
[step 08 §1](08-connectivity-tailscale.md) once Tailscale is running.

> **Docker and UFW:** Docker can insert iptables rules that bypass UFW for
> published `ports:` bindings — but here Docker is only an image builder and runs
> **no containers**, so it publishes no ports. The core stack is MicroK8s, whose
> Services are ClusterIP (no host ports) reached via the outbound tunnel; any
> NodePort exception (e.g. Trivy metrics, step 13) gets an explicit UFW rule.

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

```bash
# Add Docker's official apt repo
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
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
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
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
