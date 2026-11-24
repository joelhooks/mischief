ARG FULL_IMAGE
FROM ${FULL_IMAGE}
ARG FULL_IMAGE
USER 0:0
RUN digest="${FULL_IMAGE##*@sha256:}"; test "${#digest}" = 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac && test "$digest" != "$FULL_IMAGE"
RUN apt-get update && apt-get install -y --no-install-recommends chromium dbus fontconfig fonts-noto-core fonts-noto-color-emoji && apt-get clean && rm -r /var/lib/apt/lists
RUN npm install --global agent-browser@0.44.0 && agent-browser --version && command -v dbus-run-session
COPY --chmod=0755 apps/workspace-bridge/image/browser/peon-browser /usr/local/bin/peon-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/peon-browser
USER 65534:65534
