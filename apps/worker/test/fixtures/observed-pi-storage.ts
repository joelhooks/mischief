// @effect-diagnostics asyncFunction:off -- The test wrapper counts calls at the real SQLite adapter's Promise boundary.
import { openDurableObjectSqliteStorage as open } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

export const openDurableObjectSqliteStorage: typeof open = async (
  storage,
  options
) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS upgrade_pi_opens (value INTEGER NOT NULL)"
  );
  storage.sql.exec("INSERT INTO upgrade_pi_opens (value) VALUES (1)");

  return await open(storage, options);
};
