import { renderMaintenanceScript, renderUnits } from "@rat-king/alchemy-nest";

import { INSTANCE } from "./celld-build.ts";
import { DATA_ROOT, PORT_BASE, UNIT_LIMITS } from "./celld.ts";

export { opusBridgeUnit, renderOpusBridgeUnit } from "./opus-bridge-unit.ts";

export const mischiefUnits = (host: Parameters<typeof renderUnits>[0]) =>
  renderUnits(
    host,
    { dataRoot: DATA_ROOT, instance: INSTANCE, portBase: PORT_BASE },
    UNIT_LIMITS
  );

export const mischiefMaintenanceScript = (
  host: Parameters<typeof renderMaintenanceScript>[0]
) =>
  renderMaintenanceScript(host, {
    dataRoot: DATA_ROOT,
    instance: INSTANCE,
    portBase: PORT_BASE,
  });
