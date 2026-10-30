ARG PI_IMAGE
FROM ${PI_IMAGE}
ARG PI_IMAGE
USER 0
RUN digest="${PI_IMAGE##*@sha256:}"; test "${#digest}" = 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac && test "$digest" != "$PI_IMAGE"
RUN export PATH=/usr/local/bin:/usr/bin:/bin; for binary in pi node /bin/sh /usr/bin/env mkdir cp chmod bash which rg fd find; do command -v "$binary" || { printf 'Base image is missing %s on the cell PATH; supply a pinned base with this tool.\n' "$binary" >&2; exit 1; }; done; version="$(/usr/bin/env -i PATH="$PATH" HOME=/tmp/peon PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 RATKING_NAME=off pi --version)" || exit 1; printf 'Pi version: %s; audited version: 0.86.1\n' "$version"; test "$version" = "0.86.1" || { printf 'Pi version mismatch. Re-run the binary and writable-path audit and update this gate before choosing a different base.\n' >&2; exit 1; }
COPY image/ /opt/peon/
RUN chmod 0555 /opt/peon/entrypoint.sh && chmod 0444 /opt/peon/models.json /opt/peon/settings.json
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/opt/peon/entrypoint.sh"]
CMD ["pi", "--help"]
