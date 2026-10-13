import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Schema } from "effect";

import { forgetUnlessStored } from "../src/judge-choice.js";

it.effect.prop(
  "a submit's judge and escalateTo are forgotten only when it stored no run, so a stored run keeps them whatever the response or a dropped caller",
  { store: Schema.Literals(["no table", "empty", "stored"]) },
  ({ store }) =>
    Effect.sync(() => {
      const storage = nodeSqlStorage(":memory:");

      if (store !== "no table") {
        storage.sql.exec(
          "CREATE TABLE mischief_runs (run_id TEXT PRIMARY KEY, state TEXT NOT NULL)"
        );
      }

      if (store === "stored") {
        storage.sql.exec(
          "INSERT INTO mischief_runs (run_id, state) VALUES ('jev-proof-3', '{}')"
        );
      }

      const forgotten: string[] = [];

      forgetUnlessStored(
        storage,
        () => {
          forgotten.push("judge");
        },
        () => {
          forgotten.push("escalateTo");
        }
      );

      expect(
        forgotten,
        "a stored run lost its choices, so its next drive would use the host default"
      ).toStrictEqual(store === "stored" ? [] : ["judge", "escalateTo"]);
    }),
  { arbitrary: { runs: 30 } }
);
