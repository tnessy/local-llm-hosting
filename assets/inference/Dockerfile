# Inference image: llama-swap (model lifecycle) + TabbyAPI/ExLlamaV2 (engine).
# llama-swap is the entrypoint; it launches the TabbyAPI process for whichever
# model a request asks for (see ../llama-swap-config.yaml) and unloads it when a
# different model is needed, so models time-share the single GPU.
#
# Build is done automatically by `docker compose build inference` (steps 04a/04b).

FROM ghcr.io/theroyallab/tabbyapi:latest

# --- Install llama-swap (single static Go binary) ---------------------------
ARG LLAMA_SWAP_VERSION=v201
ADD https://github.com/mostlygeek/llama-swap/releases/download/${LLAMA_SWAP_VERSION}/llama-swap_linux_amd64 /usr/local/bin/llama-swap
RUN chmod +x /usr/local/bin/llama-swap

# llama-swap config is bind-mounted at /app/config.yaml by docker-compose.
WORKDIR /app
EXPOSE 8080

# llama-swap serves the OpenAI-compatible front door and spawns TabbyAPI as
# child processes per its config.
ENTRYPOINT ["/usr/local/bin/llama-swap"]
CMD ["--config", "/app/config.yaml", "--listen", "0.0.0.0:8080"]
