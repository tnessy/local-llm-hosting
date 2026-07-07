# 08 — Connectivity: admin (Tailscale)

← [07 Open WebUI](07-webui-open-webui.md) · Next: [09 Cloudflare](09-connectivity-cloudflare.md)

> **Overview:** Install Tailscale on the server, apply the admin ACL so only your own devices can reach `tag:llm`, restrict SSH to the LAN and Tailscale interfaces only, and validate network isolation.
>
> **Why:** Tailscale is the private admin plane — SSH and raw service ports are reachable only by your own devices on the tailnet. Friends never receive tailnet access; they use Cloudflare. Without this step, SSH remains reachable from the entire LAN and any public IPv6 address.

Tailscale (decision **D2**) is your **private** admin plane. SSH and the raw
inference/LiteLLM endpoints stay off the public internet and are reachable only
by your own devices. **Friends are never added to the tailnet** — they use
Cloudflare.

ACL: [`assets/tailscale-acl.json`](assets/tailscale-acl.json).

## 1. Install Tailscale on the server

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Allow all inbound traffic arriving on the Tailscale overlay
# (SSH, k8s API server, any admin service). UFW was enabled in step 02 §4.
sudo ufw allow in on tailscale0
```

In the Tailscale admin console, **disable key expiry** for the server node so it
doesn't drop off, and add the tag `tag:llm` to it.

> **Remote `kubectl` over Tailscale.** The MicroK8s API server binds to
> `0.0.0.0:16443`, but UFW `default deny incoming` (step 02 §4) blocks it on the
> LAN while the `tailscale0` allow rule above permits it over the tailnet. To drive
> the cluster from your laptop, point a kubeconfig at the server's Tailscale IP:
> ```bash
> microk8s config | sed "s/127.0.0.1/$(tailscale ip -4)/" > ~/.kube/microk8s-tailscale.config
> export KUBECONFIG=~/.kube/microk8s-tailscale.config
> kubectl get nodes   # verify from your laptop over Tailscale
> ```
> On the server itself, loopback `microk8s kubectl` (127.0.0.1:16443) always works.

## 2. Install Tailscale on your own devices

Install on your laptop/phone and log in to the same tailnet. You'll reach the
server by its MagicDNS name (e.g. `http://llm-server:3000`).

## 3. Apply the admin ACL

Tailscale admin console → **Access Controls** → paste
[`tailscale-acl.json`](assets/tailscale-acl.json). It allows only
`autogroup:admin` (you) to reach `tag:llm`, and denies everything else by
default.

## 4. Restrict SSH to LAN and Tailscale interfaces

SSH must only answer on your static LAN interface and the Tailscale overlay —
not on `0.0.0.0`.

1. Find your Tailscale IP:

   ```bash
   tailscale ip -4
   ```

2. Add both `ListenAddress` lines to `/etc/ssh/sshd_config`:

   ```
   # Bind SSH only to these two interfaces
   ListenAddress 192.168.x.x    # your server's static LAN IP
   ListenAddress 100.x.x.x      # your Tailscale IP from step above
   ```

3. Validate and reload:

   ```bash
   sudo sshd -t
   sudo systemctl restart ssh
   ```

4. Verify — `ss` output must show **only** your LAN and Tailscale IPs on
   port 22, not `0.0.0.0`:

   ```bash
   ss -tlnp | grep sshd
   ```

## 5. Network isolation (VLAN)

- Put the server on its **own VLAN**.
- **Router/switch:** allow VLAN → internet (model/container pulls); **deny** VLAN
  ↔ other LAN segments except what you explicitly need.
- **Host firewall (UFW):** configured in step 02 §4 — handles both IPv4 LAN
  isolation and IPv6 internet exposure (IPv6 bypasses NAT; UFW is the backstop).
  UFW and router-level VLAN isolation are complementary layers, neither replaces
  the other.
- No inbound WAN rules at all (Cloudflare + Tailscale are both outbound/overlay).

## Verification

- From a tailnet device: `http://<server>:3000` (Open WebUI) and the host UI load.
- From a device **not** on the tailnet and **not** allow-listed in Cloudflare:
  the host UI / SSH are unreachable.
- `https://llm.domain.com` still works for friends (that path is Cloudflare, not
  Tailscale).

→ Continue to [09 — Connectivity: friends (Cloudflare)](09-connectivity-cloudflare.md).
