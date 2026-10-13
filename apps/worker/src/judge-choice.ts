import {
  Judge,
  JudgeModeSchema,
  StepFailed,
  shadowJudge,
} from "@mischief/core";
import type { JudgeMode } from "@mischief/core";
import type { SqlStorage } from "@mischief/plan-run";
import { Effect, Layer, Option, Schema } from "effect";

const CHOICE =
  "CREATE TABLE IF NOT EXISTS mischief_judge (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL)";

const HOST_DEFAULT = "default";

const SubmitJudge = Schema.Struct({
  judge: Schema.optionalKey(JudgeModeSchema),
});

const decodeSubmit = Schema.decodeUnknownOption(
  Schema.fromJsonString(SubmitJudge)
);

const ChoiceRow = Schema.Struct({ mode: Schema.String });

const decodeMode = Schema.decodeUnknownOption(JudgeModeSchema);

export const fixJudgeAtFirstSubmit = (storage: SqlStorage, body: string) => {
  storage.sql.exec(CHOICE);

  const mode = decodeSubmit(body).pipe(
    Option.flatMap(({ judge }) => Option.fromNullishOr(judge)),
    Option.getOrElse((): string => HOST_DEFAULT)
  );

  const inserted = storage.transactionSync(() => {
    const fixed =
      storage.sql.exec("SELECT mode FROM mischief_judge WHERE id = 1").toArray()
        .length > 0;

    if (!fixed) {
      storage.sql.exec(
        "INSERT INTO mischief_judge (id, mode) VALUES (1, ?)",
        mode
      );
    }

    return !fixed;
  });

  return () => {
    if (inserted) {
      storage.sql.exec("DELETE FROM mischief_judge WHERE id = 1");
    }
  };
};

export const judgeModeOf = (storage: SqlStorage): Option.Option<JudgeMode> => {
  storage.sql.exec(CHOICE);

  return Option.fromNullishOr(
    storage.sql
      .exec("SELECT mode FROM mischief_judge WHERE id = 1")
      .toArray()[0]
  ).pipe(
    Option.flatMap(Schema.decodeUnknownOption(ChoiceRow)),
    Option.flatMap(({ mode }) => decodeMode(mode))
  );
};

const noJevKey = Layer.succeed(
  Judge,
  Judge.of({
    choose: ({ key }) =>
      Effect.fail(
        new StepFailed({
          key,
          reason:
            'this run was submitted with judge "jev", and this host has no MISCHIEF_JEV_KEY. Accepted: judge "shadow", or no judge for the host default. Fix: submit a new run with judge "shadow", or ask the host owner to pipe the Jev key into the bindings and redeploy, then resume',
        })
      ),
  })
);

const serviceOf = (layer: Layer.Layer<Judge>) =>
  Effect.provide(
    Effect.gen(function* readJudge() {
      return yield* Judge;
    }),
    layer
  );

export const judgeChosenPerCall = ({
  fallback,
  jev,
  storage,
}: {
  readonly fallback: JudgeMode | null;
  readonly jev: Option.Option<Layer.Layer<Judge>>;
  readonly storage: SqlStorage;
}) =>
  Layer.effect(
    Judge,
    Effect.gen(function* makeChosenJudge() {
      const shadow = yield* serviceOf(shadowJudge);
      const asked = yield* serviceOf(Option.getOrElse(jev, () => noJevKey));
      const unwired = yield* serviceOf(Judge.unwired);

      const pick = (mode: JudgeMode | null) => {
        if (mode === "shadow") {
          return shadow;
        }

        return mode === "jev" ? asked : unwired;
      };

      return Judge.of({
        choose: (call) =>
          pick(Option.getOrElse(judgeModeOf(storage), () => fallback)).choose(
            call
          ),
      });
    })
  );
