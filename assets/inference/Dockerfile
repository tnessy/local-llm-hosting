# Inference image: llama-swap (model lifecycle) + TabbyAPI/ExLlamaV2 (engine).
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

# --- Install llama-swap (single static Go binary) ---------------------------
ARG LLAMA_SWAP_VERSION=v201
# Set this to the SHA-256 of the llama-swap binary for LLAMA_SWAP_VERSION (step 04 §4).
# Get the hash:
#   curl -fsSL https://github.com/mostlygeek/llama-swap/releases/download/${LLAMA_SWAP_VERSION}/llama-swap_linux_amd64 | sha256sum
# Then either set the default below or pass --build-arg LLAMA_SWAP_SHA256=<hash> at build time.
ARG LLAMA_SWAP_SHA256
RUN test -n "${LLAMA_SWAP_SHA256}" \
      || { echo 'ERROR: set LLAMA_SWAP_SHA256 in the Dockerfile ARG or pass --build-arg (step 04 §4)'; exit 1; } \
    && wget -qO /usr/local/bin/llama-swap \
      "https://github.com/mostlygeek/llama-swap/releases/download/${LLAMA_SWAP_VERSION}/llama-swap_linux_amd64" \
    && printf '%s  /usr/local/bin/llama-swap\n' "${LLAMA_SWAP_SHA256}" | sha256sum -c \
    && chmod +x /usr/local/bin/llama-swap

# llama-swap config is mounted at /app/config.yaml from the llama-swap-config
# ConfigMap (step 04 §4).
WORKDIR /app
EXPOSE 8080

# llama-swap serves the OpenAI-compatible front door and spawns TabbyAPI as
# child processes per its config.
ENTRYPOINT ["/usr/local/bin/llama-swap"]
CMD ["--config", "/app/config.yaml", "--listen", "0.0.0.0:8080"]
