# Documentation Review — Findings

**10 findings** — Ordering conflicts: 3  Factual errors: 4  Usability/clarity: 3

Identified by a full sequential pass through steps 01–17 and `assets/` on 2026-07-01.

**Status: all 10 resolved (2026-07-06).** ORD-1 and UX-1 fixed directly; the rest
were fixed or structurally dissolved by the k8s-native rewrite (the guide moved
from a Docker Compose core + late MicroK8s migration to MicroK8s-from-step-04,
retiring `assets/docker-compose.yml` and the token-migration/ordering traps).

---

## ORDERING CONFLICTS (step cannot be completed as written at that point in the guide)

### ORD-1 — ✅ FIXED — Step 08 §2: `auth.domain.com` and `admin.domain.com` Tunnel Routes Are Premature

**Location:** `10-connectivity-cloudflare.md` §2 (hostname routing table)

**Issue:** The published-routes table in step 10 includes:
- `auth.domain.com → http://authentik-server:9000` — Authentik is not deployed until step 15
- `admin.domain.com → http://admin-ui:8080` — Admin UI is not built until step 17

A reader following the guide sequentially would configure tunnel routes to services that do not yet exist. Cloudflare's tunnel will attempt to connect and surface errors immediately.

**Impact:** Reader confusion and Cloudflare tunnel connection failures for those two entries. If the reader adds them and tests the tunnel health, it appears broken — possibly causing them to revisit and undo correct earlier steps.

**Fix:** Annotate those two rows in the table (e.g. with a `†` footnote):
- `auth.domain.com` row: "† Add in step 15 after Authentik is deployed and hardened."
- `admin.domain.com` row: "† Add in step 17 after Admin UI is deployed."

---

### ORD-2 — ✅ DISSOLVED (k8s-native rewrite) — Step 08 §6: CF Tunnel Token → k8s Secret Requires MicroK8s (Not Installed Until Step 16)

**Resolution:** MicroK8s now bootstraps in step 04. The tunnel token is created as
the `cloudflared-credentials` Secret in step 04 §3 (encrypted at rest, step 04 §2),
so there is no Docker→k8s migration. Step 08 §6 was replaced with token-hygiene
guidance (connector notifications + count check). No ordering trap remains.


**Location:** `10-connectivity-cloudflare.md` §6

**Issue:** The entire §6 migration sequence uses `microk8s kubectl create secret`, `microk8s kubectl rollout status`, and `microk8s kubectl apply`. MicroK8s is installed in step 16. At step 10 in the guide sequence there is no MicroK8s cluster. All commands in §6 fail with "microk8s: command not found" or equivalent.

**Impact:** The reader cannot complete this section at step 10. If they follow the guide linearly and skip §6, they may not return to it — leaving `CF_TUNNEL_TOKEN` in the plaintext `.env` file indefinitely.

**Fix:** Add a callout box at the top of §6:
> **⚠ Return here after step 16.** This section migrates the tunnel token to a Kubernetes Secret. MicroK8s must be installed and the `llm-platform` namespace created before any command below will work.

---

### ORD-3 — ✅ DISSOLVED (k8s-native rewrite) — Step 14 §3: Trivy Operator Requires MicroK8s (Not Installed Until Step 16)

**Resolution:** MicroK8s + `helm3` are now installed in step 04, which precedes
step 14. Trivy Operator in step 14 §3 runs against the existing cluster with no
ordering trap. No callout needed.


**Location:** `14-operations.md` §3 (Trivy Operator)

**Issue:** All commands in §3 use `microk8s enable helm3`, `microk8s helm3 install trivy-operator`, and `microk8s kubectl apply`. MicroK8s is not installed until step 16. Additionally, `microk8s enable helm3` in step 16 §1 is where helm3 is first enabled — so even if MicroK8s were somehow present, the step ordering would still fail.

**Impact:** A reader following the guide in order reaches a complete dead end at step 14 §3. The Promtail §2 config already includes a "Phase 2 — MicroK8s pod logs" block, signalling a phased approach is intended, but §3 has no corresponding phase annotation.

**Fix:** Add a callout box at the top of §3:
> **⚠ Complete this section after step 16 §1.** Trivy Operator runs on the MicroK8s cluster and requires `helm3`, which is enabled in step 16 §1. Return here after MicroK8s is installed, `calico` is running, and `microk8s enable helm3` has been run.

---

## FACTUAL ERRORS (wrong information that would cause a command or restore to fail)

### FACT-1 — ✅ FIXED (k8s-native rewrite) — Step 14 Backup Note: Wrong Location for `LITELLM_SALT_KEY`

**Resolution:** The salt key is now in the `litellm-credentials` k8s Secret
(encrypted at rest). Step 14's backup note points there with a `kubectl get secret
… salt-key | base64 -d` extraction command, and the rotation procedure patches the
Secret instead of editing `.env`.


**Location:** `14-operations.md` §Backups → `.env` backup note

**Issue:** Step 14 states:
> `.env` backup: `/opt/home-llm/.env` contains `LITELLM_SALT_KEY`

Step 04 §2 explicitly stores `LITELLM_SALT_KEY` as a Docker secret file in `/etc/home-llm/litellm_salt_key` (mode 400, root-owned). The `.env.example` has a comment: *"LiteLLM admin + salt keys are stored as Docker secrets, NOT here."* The actual `.env` does not contain the salt key.

**Impact:** A reader following the step 14 backup instruction would back up `.env` (which has no salt key) and miss the actual secret file. On a disaster restore, the `litellm.db` database would be permanently unverifiable and all friend keys would need to be re-issued.

**Fix:** Change the note to:
> **`LITELLM_SALT_KEY` backup:** `/etc/home-llm/litellm_salt_key` is the salt key file (Docker secret, mode 400, root-owned). Back this file up to your password manager — it is **not** in `.env`. Without it, `litellm.db` cannot be restored and all friend virtual keys must be re-issued.

---

### FACT-2 — ✅ FIXED (k8s-native rewrite) — Step 10 §3: Edit Command Points to Repo Source, Not Deployed File

**Resolution:** llama-swap config is now the `llama-swap-config` ConfigMap. Step 10
§3 tells the reader to edit the asset file *and* push it to the ConfigMap
(`kubectl create configmap … --dry-run -o yaml | kubectl apply -f -`) then
`rollout restart deploy/inference`, so the edit actually reaches the running pod.


**Location:** `06-models.md` §3

**Issue:** Step 10 §3 says:
> Edit `assets/llama-swap-config.yaml`

Step 04 §1 copies the entire `assets/` directory to `/opt/home-llm/` with `cp -r assets/* /opt/home-llm/`. After that command, the live deployed file is `/opt/home-llm/llama-swap-config.yaml`. The `assets/llama-swap-config.yaml` source copy in the repo is irrelevant to the running stack — editing it has no effect on the running inference container.

**Impact:** Reader edits the wrong file. The inference container sees no change; restarting it reloads the `/opt/home-llm/llama-swap-config.yaml` version (unchanged).

**Fix:** Change all references in step 06 §3 to `/opt/home-llm/llama-swap-config.yaml`.

---

### FACT-3 — ✅ DISSOLVED (k8s-native rewrite) — `docker-compose.yml` Build Context Broken After Deployment

**Resolution:** `assets/docker-compose.yml` is retired (deleted). The inference
image is built with `docker build` from `assets/inference/` and pushed to the
MicroK8s registry (step 04 §5); there is no compose build context to break.


**Location:** `assets/docker-compose.yml` line 13

**Issue:** The compose file contains:
```yaml
  inference:
    build:
      context: ./assets/inference
```
Step 04 §1 deploys with `sudo cp -r assets/* /opt/home-llm/`, placing the compose file at `/opt/home-llm/docker-compose.yml` and the inference directory at `/opt/home-llm/inference/`. When step 04 §5 runs `docker compose -f /opt/home-llm/docker-compose.yml build inference`, Docker Compose resolves relative paths from `/opt/home-llm/`. The context `./assets/inference` resolves to `/opt/home-llm/assets/inference/` — which does not exist. The build fails immediately.

Step 04 §3 shows `./llama-swap-config.yaml` (correctly, without `assets/` prefix) in the desired-state volume snippet, but the instruction only says "replace the named `models` volume" — the llama-swap path change is implied by the snippet but not called out, and the build context is never addressed at all.

**Impact:** `docker compose build inference` fails with a "build context not found" error. The stack cannot be brought up.

**Fix (two parts):**
1. In `assets/docker-compose.yml`: change `context: ./assets/inference` → `context: ./inference`. (Correct for both the deployed case and any in-repo invocation via `--project-directory assets/`.)
2. In step 04 §3: explicitly list all three changes the reader must make, not just the models volume:
   - `context: ./assets/inference` → `context: ./inference`
   - `./assets/llama-swap-config.yaml` → `./llama-swap-config.yaml`
   - `models:/models` → `/srv/models:/models`

---

### FACT-4 — ✅ DISSOLVED (k8s-native rewrite) — Optional Services in `docker-compose.yml` Reference Undefined Network `llmnet`

**Resolution:** `assets/docker-compose.yml` is retired. ComfyUI and Tabby are now
k8s manifests (`assets/k8s/llm-core/comfyui.yaml`, `tabby.yaml`) with their own
NetworkPolicies; the undefined `llmnet` Docker network no longer exists.


**Location:** `assets/docker-compose.yml` lines 127, 138 (ComfyUI and Tabby optional services)

**Issue:** Both commented-out optional services specify:
```yaml
  networks: [llmnet]
```
The compose file declares two networks: `frontend` and `backend`. `llmnet` is never defined. If a reader uncomments either service and runs `docker compose up`, it fails immediately: Docker Compose cannot find the `llmnet` network.

**Impact:** Step 11 says to "uncomment the `comfyui` service … and run `docker compose up -d comfyui`" — that command fails with a network error.

**Fix:** Change `networks: [llmnet]` to the appropriate network in both stanzas:
- `comfyui` → `networks: [frontend]` (needs to be reachable by cloudflared for the optional tunnel route in step 11)
- `tabby` → `networks: [frontend]` (same reason — optional Tailscale/tunnel access)

---

## USABILITY / CLARITY

### UX-1 — ✅ FIXED — Step 17 References Non-Existent `step 29 monitoring`

**Resolution:** Changed the cross-reference to `step 14 monitoring`.


**Location:** `17-admin-ui.md` — Audit log section

**Issue:** The audit log paragraph ends with:
> "Logs are written to a persistent volume and forwarded to the external Loki instance (step 29 monitoring)."

The guide has 17 steps. There is no step 29.

**Impact:** Broken cross-reference; reader cannot locate the referenced content.

**Fix:** Change to "step 14 monitoring".

---

### UX-2 — ✅ FIXED (k8s-native rewrite) — Step 06 §1: Undefined `<server>` Placeholder; Tailscale Access Not Yet Available

**Resolution:** Admin access is now a local `kubectl port-forward` to
`localhost:4000` (gated by the Tailscale-restricted apiserver). The `<server>`
placeholder is gone.


**Location:** `07-gateway-litellm.md` §1

**Issue:** The health check reads:
> "Run from your Tailscale-connected machine or directly on the server"
> `curl -s http://<server>:4000/health`

Tailscale is not installed until step 09. At step 07, "from your Tailscale-connected machine" is not actionable. The placeholder `<server>` is not defined in this step's preamble or anywhere in the file.

**Impact:** Reader does not know what to substitute for `<server>` and may skip the verification entirely.

**Fix:** Change to:
```bash
# Run directly on the server (Tailscale not yet available until step 09)
curl -s http://localhost:4000/health
```
Add a note: "(After step 09, you can also run this from any Tailscale-connected device using the server's tailnet hostname.)"

---

### UX-3 — ✅ FIXED (k8s-native rewrite) — Step 06 §2/§3: `$LITELLM_MASTER_KEY` Used Without Showing How to Set the Shell Variable

**Resolution:** Step 06 §2 now sets the variable explicitly from the Secret:
`LITELLM_MASTER_KEY=$(microk8s kubectl get secret litellm-credentials -n llm-core -o jsonpath='{.data.master-key}' | base64 -d)`.


**Location:** `07-gateway-litellm.md` §2 and §3

**Issue:** The key-minting curl commands use `$LITELLM_MASTER_KEY` as a shell variable:
```bash
curl ... -H "Authorization: Bearer $LITELLM_MASTER_KEY" ...
```
The master key is stored as a Docker secret file in `/etc/home-llm/litellm_master_key` — it is never an environment variable. Step 04 mentions the retrieval command ("To retrieve the master key when you need it: `sudo cat /etc/home-llm/litellm_master_key`") but that is easy to miss when re-reading step 07 in isolation, and it doesn't show how to assign the shell variable.

**Impact:** The curl commands fail silently (`Authorization: Bearer ` with an empty value) or with 401 if the variable is unset, which is indistinguishable from a misconfigured key.

**Fix:** Add before the §2 curl block:
```bash
# Set from the Docker secrets file (not an env var — stored in /etc/home-llm/)
LITELLM_MASTER_KEY=$(sudo cat /etc/home-llm/litellm_master_key)
```
