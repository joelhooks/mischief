// @effect-diagnostics asyncFunction:off -- Fetch and Web Streams expose Promise reads to the checker.
import { clipTailText, sanitizeTailText, WatchRefused } from "@mischief/core";
import type { Condition, WatchCheck } from "@mischief/core";
import { Effect, Equal, Option, Predicate, Schema } from "effect";

import { hashPeonText } from "./peon-crypto.js";

type ConditionValue = typeof Condition.Type;

type HttpCondition = Extract<ConditionValue, { type: "http" }>;

type JsonValue = Schema.Json;

export type CheckResult =
  | {
      readonly outcome: "true";
      readonly cursor: string;
      readonly detail: string;
      readonly evidence: string;
    }
  | {
      readonly outcome: Exclude<typeof WatchCheck.Type.outcome, "true">;
      readonly detail: string;
    };

const MAX_BODY_BYTES = 64 * 1024;

const pathPattern =
  /^(?:\$|[A-Za-z_][\w-]*)(?:\.[A-Za-z_][\w-]*|\[(?:0|[1-9]\d*)\])*$/u;

const pathToken = /[A-Za-z_][\w-]*|\d+/gu;

const githubPath =
  /^\$\.check_runs\[\?\(@\.name==(?<name>"(?:[^"\\]|\\.)*")\)\]\.status$/u;

const selectorName = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.String)
);

const checkRuns = Schema.decodeUnknownOption(
  Schema.Struct({
    check_runs: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.String,
        id: Schema.optionalKey(Schema.Int),
        head_sha: Schema.optionalKey(Schema.String),
        conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
        completed_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
      })
    ),
  })
);

const githubName = (path: string) =>
  selectorName(githubPath.exec(path)?.groups?.name);

const costlyRegex = /[()*+?{}]|\\[1-9]/u;

export const watchRefusal = (code: WatchRefused["code"], reason: string) =>
  new WatchRefused({ code, reason });

const badHttp = (reason: string) =>
  watchRefusal(
    "BadCondition",
    `${reason} Retry armWatch with an HTTPS URL and valid HTTP matcher.`
  );

const watchUrl = (url: string, allowlist: string | undefined) => {
  const parsed = URL.parse(url);

  if (
    parsed === null ||
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    return badHttp(
      "HTTP conditions need HTTPS on the default port, without credentials or fragments."
    );
  }

  if (
    !(allowlist ?? "")
      .split(",")
      .some((entry) => entry.trim().toLowerCase() === parsed.hostname)
  ) {
    return watchRefusal(
      "HostNotAllowed",
      "The HTTP host is not in MISCHIEF_WATCH_HTTP_HOSTS. Use an allowed host or ask the desk to allow the exact hostname, then retry armWatch."
    );
  }

  return parsed;
};

const validRegex = (pattern: string) => {
  if (costlyRegex.test(pattern)) {
    return false;
  }

  try {
    return pattern !== "" && new RegExp(pattern, "u").source.length > 0;
  } catch {
    return false;
  }
};

export const validateHttp = (
  { expect, url }: HttpCondition,
  allowlist: string | undefined
) => {
  const target = watchUrl(url, allowlist);

  if (Schema.is(WatchRefused)(target)) {
    return target;
  }

  if (
    expect.status !== undefined &&
    (expect.status < 100 || expect.status > 499)
  ) {
    return badHttp(
      "HTTP expected status must be from 100 to 499; 5xx always means checkError."
    );
  }

  if (
    expect.jsonPath !== undefined &&
    !pathPattern.test(expect.jsonPath) &&
    Option.isNone(githubName(expect.jsonPath))
  ) {
    return badHttp(
      "Use a JSON path such as $.checks[0].status or the GitHub exact-name check_runs selector."
    );
  }

  if (expect.regex !== undefined && !validRegex(expect.regex)) {
    return badHttp(
      "Use a valid regex without groups, quantifiers or backreferences so a check cannot stall the worker."
    );
  }

  return null;
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const jsonRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Json)
);

const jsonElement = Schema.decodeUnknownOption(Schema.Json);

const descend = (at: JsonValue, key: string): Option.Option<JsonValue> => {
  if (Array.isArray(at)) {
    return /^(?:0|[1-9]\d*)$/u.test(key)
      ? jsonElement(at[Number(key)])
      : Option.none();
  }

  return Option.flatMap(jsonRecord(at), (record) =>
    Object.hasOwn(record, key)
      ? Option.fromUndefinedOr(record[key])
      : Option.none()
  );
};

const atPath = (
  value: JsonValue,
  path = ""
): { readonly value: JsonValue; readonly node: JsonValue } | null => {
  const named = githubName(path);

  if (Option.isSome(named)) {
    const runs = checkRuns(value);

    if (Option.isNone(runs)) {
      throw new Error("The GitHub check_runs response did not decode.");
    }

    const matches = runs.value.check_runs.filter(
      ({ name }) => name === named.value
    );

    const run = matches.length === 1 ? matches[0] : undefined;

    return run === undefined
      ? null
      : {
          value: run.status,
          node: {
            id: run.id ?? null,
            head_sha: run.head_sha ?? null,
            status: run.status,
            conclusion: run.conclusion ?? null,
            completed_at: run.completed_at ?? null,
          },
        };
  }

  let at = value;
  let enclosing: JsonValue = null;

  for (const [key] of path.matchAll(pathToken)) {
    const child = descend(at, key);

    if (Option.isNone(child)) {
      return null;
    }

    if (Predicate.isObject(at) && !Array.isArray(at)) {
      enclosing = at;
    }

    at = child.value;
  }

  return { value: at, node: { value: at, enclosing } };
};

export const watchEvidence = (text: string) =>
  clipTailText(sanitizeTailText(text).split("\n", 12).join("\n"), 2048);

const readChunk = Schema.decodeUnknownSync(Schema.Uint8Array);

const readBody = async (body: Response["body"], signal: AbortSignal) => {
  if (body === null) {
    return "";
  }

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const pieces: string[] = [];
  let bytes = 0;

  const reader = body.getReader();

  const cancel = () => {
    void reader.cancel().catch(() => null);
  };

  signal.addEventListener("abort", cancel, { once: true });

  try {
    signal.throwIfAborted();
    let next = await reader.read();

    while (!next.done) {
      const chunk = readChunk(next.value);
      bytes += chunk.byteLength;

      if (bytes > MAX_BODY_BYTES) {
        throw new Error("HTTP response exceeds 64 KB");
      }

      pieces.push(decoder.decode(chunk, { stream: true }));
      // oxlint-disable-next-line eslint/no-await-in-loop -- A stream reader consumes one chunk at a time and stops at the byte limit.
      next = await reader.read();
    }

    signal.throwIfAborted();

    return pieces.join("") + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
};

const noMatch = (detail: string): CheckResult => ({ detail, outcome: "false" });

const checkError = (detail: string): CheckResult => ({
  detail,
  outcome: "checkError",
});

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] =>
  Array.isArray(value);

const isJsonObject = (
  value: JsonValue
): value is Readonly<Record<string, JsonValue>> =>
  Predicate.isObject(value) && !isJsonArray(value);

const canonicalJson = (value: JsonValue): string => {
  if (isJsonArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (!isJsonObject(value)) {
    return JSON.stringify(value);
  }

  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
};

const matched = (value: JsonValue, detail: string, evidence: string) =>
  Effect.try({
    try: () => canonicalJson(value),
    catch: () => checkError("The matched node exceeds the JSON nesting limit."),
  }).pipe(
    Effect.flatMap(hashPeonText),
    Effect.map((cursor): CheckResult => ({
      cursor,
      detail,
      evidence: watchEvidence(evidence),
      outcome: "true",
    })),
    Effect.orElseSucceed((result) => result)
  );

const matchContents = (body: string, expect: HttpCondition["expect"]) => {
  const found =
    expect.jsonPath !== undefined || expect.equals !== undefined
      ? atPath(decodeJson(body), expect.jsonPath)
      : { value: body, node: body };

  if (
    found === null ||
    (expect.equals !== undefined && !Equal.equals(expect.equals, found.value))
  ) {
    return noMatch("HTTP JSON value did not match.");
  }

  const { value, node } = found;
  const evidence = Predicate.isString(value) ? value : JSON.stringify(value);

  if (expect.regex === undefined) {
    return { value: node, evidence };
  }

  const match = new RegExp(expect.regex, "u").exec(evidence)?.[0];

  return match === undefined
    ? noMatch("HTTP value did not match the regex.")
    : { value: node, evidence: match };
};

const closeBody = (body: Response["body"]) => {
  void body?.cancel().catch(() => null);
};

const observe = async (
  response: Response,
  expect: HttpCondition["expect"],
  signal: AbortSignal
) => {
  const { status, body } = response;

  if (
    status >= 500 ||
    (status >= 300 && status < 400 && status !== 304) ||
    status === 0
  ) {
    closeBody(body);

    return checkError(
      `HTTP ${status} is a server failure or an untrusted redirect.`
    );
  }

  if (status !== (expect.status ?? 200)) {
    closeBody(body);

    return noMatch(`HTTP ${status} did not match the expected status.`);
  }

  if (
    expect.jsonPath === undefined &&
    expect.equals === undefined &&
    expect.regex === undefined
  ) {
    closeBody(body);

    return {
      status,
      value: [status, response.headers.get("etag")],
      evidence: `HTTP ${status}`,
    };
  }

  const match = matchContents(await readBody(body, signal), expect);

  return "outcome" in match ? match : { ...match, status };
};

export const checkHttp = Effect.fn("Watch.checkHttp")(function* checkHttp(
  condition: HttpCondition,
  allowlist: string | undefined,
  get: typeof fetch
) {
  const refusal = validateHttp(condition, allowlist);

  if (refusal !== null) {
    return checkError(refusal.reason);
  }

  const { expect, url } = condition;

  const observed = yield* Effect.tryPromise({
    catch: () =>
      "HTTP GET failed, timed out or returned an unreadable body within the 64 KB limit.",
    try: async (signal) =>
      await observe(
        await get(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "mischief-watch/1",
          },
          method: "GET",
          redirect: "manual",
          signal,
        }),
        expect,
        signal
      ),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail("HTTP GET exceeded the 10 second limit."),
    }),
    Effect.catch((error) => Effect.succeed(checkError(error)))
  );

  if ("outcome" in observed) {
    return observed;
  }

  return yield* matched(
    observed.value,
    `HTTP ${observed.status} matched.`,
    observed.evidence
  );
});

export interface PeonObservation {
  readonly state: NonNullable<
    Extract<ConditionValue, { type: "peon" }>["expect"]["state"]
  >;
  readonly pending: boolean;
  readonly lastTurnId: string | null;
}

export const checkPeon = (
  { expect }: Extract<ConditionValue, { type: "peon" }>,
  observation: PeonObservation | null
) => {
  if (observation === null) {
    return Effect.succeed(
      checkError(
        "Peon registry or owned checkpoint did not return a current observation."
      )
    );
  }

  const { state, pending, lastTurnId } = observation;

  if (
    (expect.state !== undefined && expect.state !== state) ||
    (expect.pendingClear === true && pending)
  ) {
    return Effect.succeed(
      noMatch(`Peon state ${state} or pending status did not match.`)
    );
  }

  return matched(
    [state, lastTurnId],
    `Peon state ${state} matched.`,
    `Peon state: ${state}; pending: ${pending ? "yes" : "no"}`
  );
};
