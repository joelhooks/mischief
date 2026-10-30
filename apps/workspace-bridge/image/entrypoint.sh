#!/bin/sh
set -eu
umask 077
mkdir /tmp/peon
cp /opt/peon/models.json /opt/peon/settings.json /tmp/peon/
exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 PI_CODING_AGENT_DIR=/tmp/peon PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 RATKING_NAME=off "$@"
