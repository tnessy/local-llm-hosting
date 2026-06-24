# 09 — Connectivity: admin (Tailscale)

← [08 Cloudflare](08-connectivity-cloudflare.md) · Next: [10 Models](10-models.md)

Tailscale (decision **D2**) is your **private** admin plane. SSH and the raw
inference/LiteLLM endpoints stay off the public internet and are reachable only
by your own devices. **Friends are never added to the tailnet** — they use
Cloudflare.

ACL: [`assets/tailscale-acl.json`](assets/tailscale-acl.json).

## 1. Install Tailscale on the server

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

In the Tailscale admin console, **disable key expiry** for the server node so it
doesn't drop off, and add the tag `tag:llm` to it.

## 2. Install Tailscale on your own devices

Install on your laptop/phone and log in to the same tailnet. You'll reach the
server by its MagicDNS name (e.g. `http://llm-server:3000`).

## 3. Apply the admin ACL

Tailscale admin console → **Access Controls** → paste
[`tailscale-acl.json`](assets/tailscale-acl.json). It allows only
`autogroup:admin` (you) to reach `tag:llm`, and denies everything else by
default.

## 4. Lock SSH to Tailscale

So SSH isn't exposed on the LAN broadly:

- In `/etc/ssh/sshd_config`, set `ListenAddress` to the Tailscale interface IP, or
- Restrict via your VLAN/firewall (next section) to the Tailscale subnet + your
  trusted admin subnet only.

## 5. Network isolation (VLAN)

- Put the server on its **own VLAN**.
- Firewall: allow VLAN → internet (model/container pulls); **deny** VLAN ↔ other
  LAN segments except what you explicitly need.
- No inbound WAN rules at all (Cloudflare + Tailscale are both outbound/overlay).

## Verification

- From a tailnet device: `http://<server>:3000` (Open WebUI) and the host UI load.
- From a device **not** on the tailnet and **not** allow-listed in Cloudflare:
  the host UI / SSH are unreachable.
- `https://llm.domain.com` still works for friends (that path is Cloudflare, not
  Tailscale).

→ Continue to [10 — Models](10-models.md).
