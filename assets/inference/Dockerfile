# Inference image: llama-swap (model lifecycle) + TabbyAPI (engine; ExLlamaV3,
# EXL2-compatible — TabbyAPI auto-detects the backend per model).
# llama-swap is the entrypoint; it launches the TabbyAPI process for whichever
# model a request asks for (see ../llama-swap-config.yaml) and unloads it when a
# different model is needed, so models time-share the single GPU.
#
# Built with `docker build` and pushed to the MicroK8s registry (step 04 §5).
#
# Before building, pin this base image to a digest (step 04 §4):
#   docker pull ghcr.io/theroyallab/tabbyapi:latest
#   docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/theroyallab/tabbyapi:latest
# Then replace :latest below with :latest@sha256:<digest>
FROM ghcr.io/theroyallab/tabbyapi:latest

# --- Install llama-swap (shipped as a release tarball) ----------------------
ARG LLAMA_SWAP_VERSION=v235
# SHA-256 of the linux_amd64 TARBALL for LLAMA_SWAP_VERSION (step 04 §5). The
# release filename drops the leading "v" (e.g. v235 → llama-swap_235_...). Get the
# hash from the release checksums file:
#   curl -fsSL https://github.com/mostlygeek/llama-swap/releases/download/${LLAMA_SWAP_VERSION}/llama-swap_${LLAMA_SWAP_VERSION#v}_checksums.txt | grep linux_amd64.tar.gz
# Then set the default below or pass --build-arg LLAMA_SWAP_SHA256=<hash> at build time.
ARG LLAMA_SWAP_SHA256
# python3.12-dev (below) provides Python.h so Triton can JIT-compile its CUDA
# kernels at runtime — required by newer ExLlamaV3 archs (Qwen3.5 Gated DeltaNet,
# Gemma-4 paged attention); without it those models crash on load. gcc + libcuda
# already ship in the tabbyapi base image. See deployments/surtr.md.
RUN test -n "${LLAMA_SWAP_SHA256}" \
      || { echo 'ERROR: set LLAMA_SWAP_SHA256 (step 04 §5)'; exit 1; } \
    && apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates python3.12-dev \
    && ver="${LLAMA_SWAP_VERSION#v}" \
    && wget -qO /tmp/llama-swap.tgz \
      "https://github.com/mostlygeek/llama-swap/releases/download/${LLAMA_SWAP_VERSION}/llama-swap_${ver}_linux_amd64.tar.gz" \
    && printf '%s  /tmp/llama-swap.tgz\n' "${LLAMA_SWAP_SHA256}" | sha256sum -c \
    && mkdir -p /tmp/lsx \
    && tar -xzf /tmp/llama-swap.tgz -C /tmp/lsx \
    && install -m 0755 "$(find /tmp/lsx -type f -name llama-swap | head -1)" /usr/local/bin/llama-swap \
    && rm -rf /tmp/llama-swap.tgz /tmp/lsx /var/lib/apt/lists/*

# Generic launcher that redirects TabbyAPI's output to a file so llama-swap's
# undrained stderr pipe can't stall/kill a verbose model's load (e.g. phi-4-reasoning
# — see deployments/surtr.md "Rollout gotchas"). Point each llama-swap `cmd:` at
# `bash /usr/local/bin/tabby-run.sh <main.py args>` instead of `python3` directly.
COPY tabby-run.sh /usr/local/bin/tabby-run.sh
RUN chmod +x /usr/local/bin/tabby-run.sh

# llama-swap config is mounted at /app/config.yaml from the llama-swap-config
# ConfigMap (step 04 §4).
WORKDIR /app
EXPOSE 8080

# llama-swap serves the OpenAI-compatible front door and spawns TabbyAPI as
# child processes per its config.
ENTRYPOINT ["/usr/local/bin/llama-swap"]
CMD ["--config", "/app/config.yaml", "--listen", "0.0.0.0:8080"]
