// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- A stand-in for the nest CLI: a separate Node process that keeps Rat King's admission state in files.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Sealed {
  readonly aad: { readonly messageId: string };
}

interface Admitted {
  readonly bytes: unknown;
  readonly seq: unknown;
}

const isText = (value: unknown): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

const isSealed = (value: unknown): value is Sealed =>
  value instanceof Object &&
  "aad" in value &&
  value.aad instanceof Object &&
  "messageId" in value.aad &&
  isText(value.aad.messageId);

const isAdmitted = (value: unknown): value is Admitted =>
  value instanceof Object && "bytes" in value && "seq" in value;

const readSealed = (text: string): Sealed => {
  const value: unknown = JSON.parse(text);

  if (!isSealed(value)) {
    throw new Error(
      `sealed envelope on stdin lacks a string aad.messageId: ${text.slice(0, 200)}`
    );
  }

  return value;
};

const readAdmitted = (file: string): Admitted => {
  const value: unknown = JSON.parse(readFileSync(file, "utf-8"));

  if (!isAdmitted(value)) {
    throw new Error(`${file} lacks bytes or seq`);
  }

  return value;
};

const state = process.env.FAKE_NEST_STATE ?? "";

const fail = (code: number, reason: string) => {
  process.stderr.write(`${reason}\n`);
  process.exit(code);
};

const counter = (name: string) => {
  const file = path.join(state, name);
  const next = existsSync(file) ? Number(readFileSync(file, "utf-8")) + 1 : 1;

  writeFileSync(file, String(next));

  return next;
};

const flag = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? undefined : process.argv[at + 1];
};

const readStdin = async () => {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf-8");
};

const seal = () => {
  const to = flag("to");

  if (to === "nobody/here") {
    fail(2, "UnknownName: nobody/here");
  }

  const messageId = `3fake${String(counter("sealed")).padStart(8, "0")}`;

  process.stdout.write(
    `${JSON.stringify({
      envelope: {
        aad: { from: flag("as"), messageId, to },
        body: flag("body"),
        nonce: randomUUID(),
        summary: flag("summary"),
      },
      messageId,
    })}\n`
  );
};

const send = async () => {
  const bytes = await readStdin();
  const { aad } = readSealed(bytes);
  const admitted = path.join(state, "admitted", `${aad.messageId}.json`);
  const uncertain = path.join(state, "uncertain");

  const left = existsSync(uncertain)
    ? Number(readFileSync(uncertain, "utf-8"))
    : 0;

  if (left > 0) {
    writeFileSync(uncertain, String(left - 1));
    fail(3, "UNCERTAIN: no acknowledgement");
  }

  if (existsSync(admitted)) {
    const stored = readAdmitted(admitted);

    if (stored.bytes !== bytes) {
      fail(5, `Conflict: ${aad.messageId} was admitted with other bytes`);
    }

    process.stdout.write(
      `${JSON.stringify({ id: aad.messageId, seq: stored.seq })}\n`
    );

    return;
  }

  const seq = counter("seq");

  writeFileSync(admitted, JSON.stringify({ bytes, seq }));
  process.stdout.write(`${JSON.stringify({ id: aad.messageId, seq })}\n`);
};

if (state === "") {
  fail(2, "FAKE_NEST_STATE is not set");
}

mkdirSync(path.join(state, "admitted"), { recursive: true });

const [command] = process.argv.slice(2);

if (command === "seal") {
  seal();
} else if (command === "send") {
  await send();
} else {
  fail(2, `unknown command ${command ?? ""}`);
}
