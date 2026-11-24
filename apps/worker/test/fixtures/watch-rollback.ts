// @effect-diagnostics asyncFunction:off -- workerd invokes this fixture through its native test and Durable Object RPC APIs.
import { WatchObject } from "../../src/watch-object.js";

export class StoredWatch extends WatchObject {
  async seed() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE watches (id TEXT PRIMARY KEY, cursor INTEGER)"
    );
    this.ctx.storage.sql.exec("INSERT INTO watches VALUES ('kept', 42)");

    const alarm = 4_102_444_800_000;
    await this.ctx.storage.setAlarm(alarm);

    return alarm;
  }

  runAlarm() {
    super.alarm();
  }

  async storedState() {
    const rows = this.ctx.storage.sql.exec("SELECT * FROM watches").toArray();
    const alarm = await this.ctx.storage.getAlarm();

    return { alarm, rows };
  }
}

export default {
  async test(
    _controller: TestController,
    { WATCH }: { WATCH: DurableObjectNamespace<StoredWatch> }
  ) {
    const watch = WATCH.getByName("existing-watch");
    const seededAlarm = await watch.seed();

    const responses = await Promise.all(
      ["GET", "POST", "DELETE"].map(async (method) => {
        const response = await watch.fetch("https://watch.example.invalid/", {
          method,
        });

        return { body: await response.text(), status: response.status };
      })
    );

    for (const { body, status } of responses) {
      if (status !== 503 || !body.includes('"code":"WatchesDisabled"')) {
        throw new Error(
          `Expected 503 WatchesDisabled, received ${status}: ${body}`
        );
      }
    }

    await watch.runAlarm();

    const { alarm, rows } = await watch.storedState();

    if (
      alarm !== seededAlarm ||
      JSON.stringify(rows) !== '[{"id":"kept","cursor":42}]'
    ) {
      throw new Error(
        `Expected untouched watch rows and alarm, received ${JSON.stringify({ alarm, rows })}`
      );
    }
  },
};
