// @effect-diagnostics asyncFunction:off -- Alchemy captures cwd at import, so the stack loads by dynamic import after the state directory is selected.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Layer, Match, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

const refuse = (reason: string) => Effect.die(new Error(reason));

const program = Effect.gen(function* plan() {
  if ((yield* Config.String("ALCHEMY_TELEMETRY_DISABLED")) !== "1") {
    return yield* refuse(
      "set ALCHEMY_TELEMETRY_DISABLED=1; the plan sends nothing anywhere"
    );
  }

  const action = yield* Schema.decodeUnknownEffect(
    Schema.Literals([
      "plan",
      "deploy",
      "destroy-plan",
      "destroy",
      "probe",
      "render-units",
    ])
  )(process.argv[2] ?? "plan").pipe(
    Effect.catch(() =>
      refuse(
        "unknown action. Use plan, deploy, destroy-plan, destroy, probe or render-units"
      )
    )
  );

  const target = yield* Config.Literals(
    ["celld", "cloudflare"],
    "MISCHIEF_TARGET"
  ).pipe(Config.withDefault("celld" as const));

  const online = yield* Config.Boolean("MISCHIEF_ONLINE_PLAN").pipe(
    Config.withDefault(false)
  );

  const approved = yield* Config.Boolean("MISCHIEF_PLAN_APPROVED").pipe(
    Config.withDefault(false)
  );

  if (action !== "plan" && target !== "celld") {
    return yield* refuse(
      "only an offline plan touches the Cloudflare stack; anything more needs Joel's own yes"
    );
  }

  const deployApproved = yield* Config.Boolean("MISCHIEF_CELLD_APPROVED").pipe(
    Config.withDefault(false)
  );

  const destroyApproved = yield* Config.Boolean(
    "MISCHIEF_DESTROY_APPROVED"
  ).pipe(Config.withDefault(false));

  const review = yield* Config.String("MISCHIEF_REVIEW").pipe(
    Config.withDefault("")
  );

  if (action === "deploy" && (!deployApproved || review.trim() === "")) {
    return yield* refuse(
      "deploy needs MISCHIEF_CELLD_APPROVED=true and MISCHIEF_REVIEW naming the plan approvals (Tin-Tin's and Servo's message ids), under Joel's pre-approval for this instance only"
    );
  }

  if (action === "destroy" && !destroyApproved) {
    return yield* refuse(
      "destroy needs MISCHIEF_DESTROY_APPROVED=true; run destroy-plan first and read it"
    );
  }

  if (action === "probe" && !deployApproved && !destroyApproved) {
    return yield* refuse(
      "the probe reads the host over SSH; set MISCHIEF_CELLD_APPROVED or MISCHIEF_DESTROY_APPROVED"
    );
  }

  if (online && target === "celld") {
    return yield* refuse(
      "the celld plan is offline only for now; an online plan reads the host over SSH, which comes with the approved deploy"
    );
  }

  if (online && !approved) {
    return yield* refuse(
      "an online plan reads the Cloudflare account; set MISCHIEF_PLAN_APPROVED=true only after Joel approves account access"
    );
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(path.resolve(import.meta.dirname, "../.."));
  const directory = path.resolve(yield* Config.String("MISCHIEF_STATE_DIR"));

  if (directory === root || directory.startsWith(`${root}/`)) {
    return yield* refuse(
      "MISCHIEF_STATE_DIR is inside the repository; state must live outside it. Point it at a private directory such as ~/.local/state/mischief"
    );
  }

  yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
  yield* fs.chmod(directory, 0o700);
  process.chdir(yield* fs.realPath(directory));

  const runtime = yield* Effect.promise(
    async () => await import("./plan-runtime.ts")
  );

  return yield* Match.value(action).pipe(
    Match.when("plan", () => runtime.planStack(target, online)),
    Match.when("deploy", () => runtime.deployCelld(review)),
    Match.when("destroy-plan", () => runtime.destroyPlanCelld),
    Match.when("destroy", () => runtime.destroyCelld),
    Match.when("probe", () => runtime.probeCelld),
    Match.when("render-units", () => runtime.renderUnitsCelld),
    Match.exhaustive
  );
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
  )
);
