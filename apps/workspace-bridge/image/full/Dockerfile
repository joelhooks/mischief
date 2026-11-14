ARG NODE_IMAGE
ARG CLAUDE_BRIDGE_IMAGE
FROM ${CLAUDE_BRIDGE_IMAGE} AS claude_bridge
FROM ${NODE_IMAGE}
ARG NODE_IMAGE
ARG CLAUDE_BRIDGE_IMAGE
ARG PI_VERSION
RUN digest="${NODE_IMAGE##*@sha256:}"; test "${#digest}" = 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac && test "$digest" != "$NODE_IMAGE"
RUN digest="${CLAUDE_BRIDGE_IMAGE##*@sha256:}"; test "${#digest}" = 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac && test "$digest" != "$CLAUDE_BRIDGE_IMAGE"
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep fd-find python3 build-essential tar coreutils && apt-get clean && ln -s /usr/bin/fdfind /usr/local/bin/fd
RUN test -n "$PI_VERSION" && npm install --global "@earendil-works/pi-coding-agent@$PI_VERSION" && test "$(pi --version)" = "$PI_VERSION"
COPY --from=claude_bridge /opt/claude-bridge /opt/claude-bridge
RUN test -s /opt/claude-bridge/COMMIT && grep -Eq '^[0-9a-f]{40}$' /opt/claude-bridge/COMMIT && test -f /opt/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/cli.js && ln -s /opt/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/cli.js /usr/local/bin/claude && claude --version
COPY apps/workspace-bridge/image/full/models.json apps/workspace-bridge/image/full/settings.json /opt/peon/
RUN mkdir -p /work /home/peon/.pi/agent && cp /opt/peon/models.json /opt/peon/settings.json /home/peon/.pi/agent/ && chown -R 65534:65534 /work /home/peon
ENV HOME=/home/peon PI_CODING_AGENT_DIR=/home/peon/.pi/agent
ENV ANTHROPIC_BASE_URL=http://172.30.212.1:28013 ANTHROPIC_AUTH_TOKEN=proxy OPENAI_BASE_URL=http://172.30.212.1:28013/v1
USER 65534:65534
WORKDIR /work
CMD ["sleep", "infinity"]
