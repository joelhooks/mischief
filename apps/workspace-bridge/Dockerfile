ARG PI_IMAGE
FROM ${PI_IMAGE}
ARG PI_IMAGE
USER 0
RUN digest="${PI_IMAGE##*@sha256:}"; test "${#digest}" = 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac && test "$digest" != "$PI_IMAGE"
RUN command -v pi && command -v bash && command -v rg && command -v find && command -v env
COPY image/ /opt/peon/
RUN chmod 0555 /opt/peon/entrypoint.sh && chmod 0444 /opt/peon/models.json /opt/peon/settings.json
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/opt/peon/entrypoint.sh"]
CMD ["pi", "--help"]
