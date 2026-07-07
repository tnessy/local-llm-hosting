# 04 — Bootstrap MicroK8s + deploy the core stack (Ubuntu)

← [03 Storage](03-storage-ubuntu.md) · Next: [05 Inference](05-inference-tabbyapi-llamaswap.md)

> **Overview:** Install MicroK8s and its add-ons (Calico, GPU, hostpath storage, Helm, registry), turn on Secrets encryption at rest, then deploy the model-serving core — `inference`, `litellm`, `open-webui`, and `cloudflared` — as Kubernetes manifests in the `llm-core` and `llm-platform` namespaces.
>
> **Why:** MicroK8s is the single platform for the whole stack. Running the core here from day one — rather than on Docker Compose and migrating later — means Secrets, NetworkPolicy isolation, and the per-user workspace plane (step 16) all share one substrate. Kubernetes restarts crashed pods and reschedules on reboot, so no systemd unit is needed.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `CF_TUNNEL_TOKEN` | Cloudflare tunnel credential | Cloudflare Zero Trust → Tunnels → your tunnel → copy token (step 01) |

> **Docker is still installed (step 02) — but only as an image builder.** The core
> services run as Kubernetes pods, not Docker containers. Docker is used in §5
> solely to `docker build` the inference image and push it to the MicroK8s
> registry.

## 0. Get the repo onto the server

Clone this repository to `/opt/home-llm` so the manifests and config assets are
local. Create the directory owned by your user **first**, so the clone runs with
your own git credentials rather than root's (matters for a private repo):

```bash
sudo mkdir -p /opt/home-llm
sudo chown "$USER":"$USER" /opt/home-llm
git clone <your-repo-url> /opt/home-llm
cd /opt/home-llm
```

Working from a local checkout instead of a remote? Copy it in place instead:

```bash
sudo cp -r . /opt/home-llm/
sudo chown -R "$USER":"$USER" /opt/home-llm
cd /opt/home-llm
```

All commands below assume `cd /opt/home-llm`. Manifests live in
[`assets/k8s/`](assets/k8s/); config assets (`litellm-config.yaml`,
`llama-swap-config.yaml`, `inference/Dockerfile`) live in [`assets/`](assets/).

## 1. Install MicroK8s + add-ons

```bash
# Pin to a stable channel so snap auto-refresh can't jump minor versions.
# Replace <minor> with the current MicroK8s stable minor (e.g. `snap info microk8s`).
sudo snap install microk8s --classic --channel=<minor>/stable

# Run kubectl without sudo
sudo usermod -aG microk8s "$USER"
newgrp microk8s                       # or log out/in
microk8s status --wait-ready
```

Enable the add-ons the stack depends on. **Calico is already MicroK8s's default
CNI** (running out of the box — there is no `enable calico`); it enforces the
NetworkPolicies this stack relies on. The rest are off by default:

```bash
microk8s enable dns                 # CoreDNS (usually already enabled)
microk8s enable rbac                # ENFORCE RBAC — without this the orchestrator least-privilege model (step 16) is a no-op
microk8s enable gpu                 # NVIDIA device plugin (for llm-core inference)
microk8s enable hostpath-storage    # PVC provisioner for litellm-db + openwebui-data
microk8s enable helm3               # Authentik (step 15)
microk8s enable registry            # local image registry at localhost:32000 (§5)
```

> **Why `rbac` matters:** MicroK8s runs the apiserver with authorization mode
> `AlwaysAllow` until you enable `rbac`. The two-tier orchestrator RBAC in step 16
> (and the C-3/C-4 fixes that keep a compromised orchestrator out of `llm-core`)
> only take effect once RBAC is actually enforced. Enable it now, before any
> workload is deployed.

**Wait for Calico to be fully ready before deploying anything.** Kubernetes
silently accepts NetworkPolicy resources whether or not a CNI is enforcing them —
a crash-looping or absent Calico means every policy is a no-op with no error.

```bash
microk8s kubectl rollout status daemonset/calico-node -n kube-system
microk8s kubectl get daemonset calico-node -n kube-system
# Expected: DESIRED=1  CURRENT=1  READY=1  (single-node cluster)
```

Confirm the GPU plugin registered the card (may take a few minutes on first enable):

```bash
microk8s kubectl get nodes -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}{"\n"}'
# Expected: 1 (or your GPU count)
```

> **Pin snap auto-refresh to a maintenance window.** Uncontrolled snap updates can
> restart `calico-node` during working hours, briefly dropping NetworkPolicy
> enforcement. Move updates to a low-traffic window (`refresh.timer` is the current
> snapd key; `refresh.schedule` is deprecated):
> ```bash
> sudo snap set system refresh.timer="tue,01:00-03:00"
> snap refresh --time      # verify: shows the timer + next scheduled refresh
> ```
>
> **API server access** is restricted to Tailscale in [step 09](09-connectivity-tailscale.md).
> Until then, UFW `default deny incoming` (step 02 §4) blocks LAN access to
> `16443`; loopback `microk8s kubectl` from the host always works.

## 2. Enable Secrets encryption at rest

MicroK8s does not encrypt Kubernetes Secrets on disk by default — they are
base64-encoded plaintext in the dqlite datastore, readable by any process with
host filesystem access. Enable `secretbox` (XSalsa20 + Poly1305) so every Secret
value is encrypted **before** it is written — do this **before creating any
Secret in §3**.

Generate a 32-byte base64 key and print it (copy it to your password manager now
— you'll also paste it into the file in the next step):

```bash
openssl rand -base64 32
```

Open the encryption config in an editor:

```bash
sudo nano /var/snap/microk8s/current/args/encryption-config.yaml
```

Paste this, replacing `<ENC_KEY>` with the value printed above:

```
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - secretbox:
      keys:
      - name: key1
        secret: <ENC_KEY>          # ← paste the base64 key printed above
  - identity: {}
```

Lock down the file, register it with the apiserver, and restart:

```bash
sudo chmod 400 /var/snap/microk8s/current/args/encryption-config.yaml
sudo chown root:root /var/snap/microk8s/current/args/encryption-config.yaml

# Appends a single line to the apiserver args file
echo '--encryption-provider-config=/var/snap/microk8s/current/args/encryption-config.yaml' | sudo tee -a /var/snap/microk8s/current/args/kube-apiserver > /dev/null

sudo snap restart microk8s
microk8s kubectl get nodes            # Ready = apiserver is back up
```

> **Back up the encryption key to your password manager now.** If
> `encryption-config.yaml` is lost, every Secret in the cluster becomes
> unreadable and the whole stack must be re-provisioned.

## 3. Create the namespaces and Secrets

```bash
microk8s kubectl apply -f assets/k8s/00-namespaces.yaml
```

All stack credentials are Kubernetes Secrets (encrypted at rest by §2), sourced
into pods via `secretKeyRef` — never inline `value:` literals, which are readable
from the pod spec by anything with `pods:get`.

```bash
# LiteLLM admin (master) + virtual-key salt. Master key must start with "sk-".
# Both are printed so you can record them — the master key mints friend keys
# (step 06); the salt key is PERMANENT and required to restore litellm.db (step 14).
LITELLM_MASTER_KEY="sk-$(openssl rand -hex 32)"
LITELLM_SALT_KEY="$(openssl rand -hex 32)"
echo "LITELLM_MASTER_KEY=$LITELLM_MASTER_KEY"   # copy to your password manager
echo "LITELLM_SALT_KEY=$LITELLM_SALT_KEY"       # copy to your password manager — PERMANENT
microk8s kubectl create secret generic litellm-credentials -n llm-core --from-literal=master-key="$LITELLM_MASTER_KEY" --from-literal=salt-key="$LITELLM_SALT_KEY"

# Internal key TabbyAPI requires; shared by inference (server) and litellm (client)
microk8s kubectl create secret generic tabby-credentials -n llm-core --from-literal=api-key="$(openssl rand -hex 32)"

# Open WebUI: session-signing secret now; the litellm-key is minted in step 06,
# so seed it empty and patch it there.
microk8s kubectl create secret generic openwebui-credentials -n llm-core --from-literal=secret-key="$(openssl rand -hex 32)" --from-literal=litellm-key=""

# Cloudflare tunnel token (step 01). Read it via a SILENT prompt and pipe it in on
# stdin — the token never lands in shell history or /proc/<pid>/cmdline. printf '%s'
# avoids a trailing newline (which would break cloudflared auth).
read -rsp "Paste the CF tunnel token, then press Enter: " CF_TOKEN; echo
printf '%s' "$CF_TOKEN" | microk8s kubectl create secret generic cloudflared-credentials -n llm-platform --from-file=token=/dev/stdin
unset CF_TOKEN
```

> **`salt-key` is permanent.** Changing it after setup silently invalidates every
> friend virtual key. It lives only in the encrypted Secret — copy it to your
> password manager now. See [step 14](14-operations.md) for the rotation
> procedure if a leak ever forces it.

## 4. Create the config ConfigMaps

`litellm` and `inference` read their configs from ConfigMaps built from the asset
files (edit those files in later steps, then re-apply — see §7 note):

```bash
microk8s kubectl create configmap litellm-config -n llm-core --from-file=litellm-config.yaml=assets/litellm-config.yaml

microk8s kubectl create configmap llama-swap-config -n llm-core --from-file=llama-swap-config.yaml=assets/llama-swap-config.yaml
```

## 5. Build the inference image and push it to the registry

The inference image (llama-swap + TabbyAPI/ExLlamaV2) is built locally and pushed
to the MicroK8s registry at `localhost:32000`, which the cluster pulls from.

First get the integrity values the Dockerfile requires — the llama-swap binary
SHA-256 and (optionally) the TabbyAPI base digest:

```bash
LLAMA_SWAP_VERSION=v235   # must match ARG LLAMA_SWAP_VERSION in assets/inference/Dockerfile
# The release filename drops the leading "v" (v235 → llama-swap_235_...). The SHA-256
# for the linux_amd64 tarball is the first column of the matching checksums line:
curl -fsSL "https://github.com/mostlygeek/llama-swap/releases/download/${LLAMA_SWAP_VERSION}/llama-swap_${LLAMA_SWAP_VERSION#v}_checksums.txt" | grep linux_amd64.tar.gz
```

Build and push:

```bash
cd /opt/home-llm/assets/inference

# Builds run as `sudo docker` — no one is in the docker group (step 02 §6)
sudo docker build --build-arg LLAMA_SWAP_SHA256=<paste-hash-here> -t localhost:32000/home-llm-inference:latest .

sudo docker push localhost:32000/home-llm-inference:latest
cd /opt/home-llm
```

## 6. Pin image digests

> **Why:** Floating tags (`:latest`, `:main-stable`) resolve to different content
> on every pull. Pinning to SHA-256 digests ensures each pull gets exactly what
> you verified — a supply-chain swap of upstream image content is caught before it
> reaches the cluster.

Pull the third-party images into MicroK8s and record their digests, plus the
digest of the inference image you just pushed:

```bash
for img in ghcr.io/berriai/litellm:main-stable ghcr.io/open-webui/open-webui:main cloudflare/cloudflared:latest ; do
  microk8s ctr images pull "docker.io/library/$img" 2>/dev/null || microk8s ctr images pull "$img"
done

# Third-party digests
microk8s ctr images ls | grep -E 'litellm|open-webui|cloudflared'
# Inference image digest (from the push in §5)
sudo docker inspect --format='{{index .RepoDigests 0}}' localhost:32000/home-llm-inference:latest
```

Append `@sha256:<digest>` to each `image:` line in the manifests:

- `assets/k8s/llm-core/inference.yaml` → `localhost:32000/home-llm-inference:latest@sha256:<digest>`
- `assets/k8s/llm-core/litellm.yaml` → `ghcr.io/berriai/litellm:main-stable@sha256:<digest>`
- `assets/k8s/llm-core/open-webui.yaml` → `ghcr.io/open-webui/open-webui:main@sha256:<digest>`
- `assets/k8s/llm-platform/cloudflared.yaml` → `cloudflare/cloudflared:latest@sha256:<digest>`

> [Step 14](14-operations.md) documents how to re-record digests before pulling
> updates, diff what changed, and re-pin after reviewing changelogs.

## 7. Install Traefik (Gateway API ingress)

cloudflared forwards all tunnel traffic to Traefik, which routes by Host header.
Install it as the Gateway API controller in `llm-platform`:

```bash
microk8s helm3 repo add traefik https://helm.traefik.io/traefik
microk8s helm3 repo update

microk8s helm3 install traefik traefik/traefik --namespace llm-platform --set providers.kubernetesGateway.enabled=true --set providers.kubernetesCRD.enabled=true --set service.type=ClusterIP   # cloudflared reaches it in-cluster; no NodePort
```

Before applying the NetworkPolicies, confirm the k8s API server ClusterIP matches
the `traefik-policy` egress rule (`10.96.0.1` is the MicroK8s default):

```bash
microk8s kubectl get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}{"\n"}'
# If not 10.96.0.1, update the ipBlock in assets/k8s/llm-platform/networkpolicies.yaml
```

## 8. Deploy the core stack

Apply the default-deny baselines **first**, then the workloads, ingress, and
allow policies. Replace `domain.com` in `core-gateway.yaml` and
`core-httproutes.yaml` with your domain before applying.

```bash
# 1. Default-deny baselines (before anything else in each namespace)
microk8s kubectl apply -f assets/k8s/llm-core/default-deny.yaml
microk8s kubectl apply -f assets/k8s/llm-platform/default-deny.yaml

# 2. Workloads + Services
microk8s kubectl apply -f assets/k8s/llm-core/inference.yaml
microk8s kubectl apply -f assets/k8s/llm-core/litellm.yaml
microk8s kubectl apply -f assets/k8s/llm-core/open-webui.yaml
microk8s kubectl apply -f assets/k8s/llm-platform/cloudflared.yaml

# 3. Ingress: Gateway + HTTPRoutes
microk8s kubectl apply -f assets/k8s/llm-platform/core-gateway.yaml
microk8s kubectl apply -f assets/k8s/llm-core/core-httproutes.yaml

# 4. Explicit allow policies (layer on top of default-deny)
microk8s kubectl apply -f assets/k8s/llm-core/networkpolicies.yaml
microk8s kubectl apply -f assets/k8s/llm-platform/networkpolicies.yaml
```

Watch the pods come up:

```bash
microk8s kubectl get pods -n llm-core -w
# inference (GPU), litellm, open-webui → Running
microk8s kubectl get pods -n llm-platform
# cloudflared, traefik → Running
```

> **Isolation is enforced from here on.** default-deny plus the explicit allow
> policies mean inference is reachable only from litellm, backends only from
> Traefik, and nothing is exposed to the LAN or internet except the outbound
> Cloudflare tunnel. Step 16 adds the per-workspace policies on top; the
> `workspace=true` / `admin-ui` / `authentik` clauses already present here match
> nothing until those workloads exist.
>
> **Editing config later:** when a step tells you to edit `litellm-config.yaml` or
> `llama-swap-config.yaml`, re-create the ConfigMap (`microk8s kubectl create
> configmap … --from-file=… --dry-run=client -o yaml | microk8s kubectl apply -f -`)
> and restart the Deployment (`microk8s kubectl rollout restart deploy/<name> -n llm-core`).

## 9. Confirm the GPU is visible inside the engine

```bash
microk8s kubectl exec -n llm-core deploy/inference -- nvidia-smi
```

You should see the GPU **inside** the pod. If not, recheck `microk8s enable gpu`
(§1) and the NVIDIA driver from [step 02](02-host-os-ubuntu.md).

## Verification

- `microk8s kubectl get pods -n llm-core` shows `inference`, `litellm`,
  `open-webui` all `Running`; `-n llm-platform` shows `cloudflared` `Running`.
- `microk8s kubectl exec -n llm-core deploy/inference -- nvidia-smi` sees the GPU.
- `microk8s kubectl port-forward -n llm-core svc/open-webui 3000:8080` then
  `curl -s http://localhost:3000` returns the Open WebUI page (local only).

→ Continue to [05 — Inference](05-inference-tabbyapi-llamaswap.md).
