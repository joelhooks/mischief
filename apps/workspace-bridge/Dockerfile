ARG PI_IMAGE
ARG CLAUDE_BRIDGE_IMAGE=mischief-claude-bridge@sha256:5a7a6c34db70821cc49f8e2c30db53e31fd6d4093e78314480a3e436532684bf
FROM ${CLAUDE_BRIDGE_IMAGE} AS bridge
FROM ${PI_IMAGE}
ARG PI_IMAGE
ARG CLAUDE_BRIDGE_IMAGE
USER 0
RUN digest="${PI_IMAGE##*@sha256:}"; test "${#digest}" = 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac && test "$digest" != "$PI_IMAGE"
RUN export PATH=/usr/local/bin:/usr/bin:/bin; for binary in pi node /bin/sh /usr/bin/env mkdir cp chmod bash which rg fd find; do command -v "$binary" || { printf 'Base image is missing %s on the cell PATH; supply a pinned base with this tool.\n' "$binary" >&2; exit 1; }; done; version="$(/usr/bin/env -i PATH="$PATH" HOME=/tmp/peon PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 RATKING_NAME=off pi --version)" || exit 1; printf 'Pi version: %s; audited version: 0.86.1\n' "$version"; test "$version" = "0.86.1" || { printf 'Pi version mismatch. Re-run the binary and writable-path audit and update this gate before choosing a different base.\n' >&2; exit 1; }
RUN digest="${CLAUDE_BRIDGE_IMAGE##*@sha256:}"; test "${#digest}" = 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac && test "$digest" != "$CLAUDE_BRIDGE_IMAGE"
COPY --from=bridge /opt/claude-bridge /opt/claude-bridge
RUN test -r /opt/claude-bridge/src/index.ts && test "$(/bin/sh -c 'read -r commit < /opt/claude-bridge/COMMIT; printf %s "$commit"')" = "743aaba5b85a3a788258fd1d1998b6dacc6e790c" && /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 /opt/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version
COPY image/ /opt/peon/
RUN chmod 0555 /opt/peon/entrypoint.sh && chmod 0444 /opt/peon/models.json /opt/peon/settings.json /opt/peon/claude-bridge.json
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/opt/peon/entrypoint.sh"]
CMD ["pi", "--help"]
