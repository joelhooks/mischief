// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- A stand-in for the nest CLI: a separate Node process that keeps Rat King's admission state in files.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

const SealedSchema = Schema.fromJsonString(
  Schema.Struct({
    aad: Schema.Struct({ messageId: Schema.String }),
  })
);

const AdmittedSchema = Schema.fromJsonString(
  Schema.Struct({ bytes: Schema.String, seq: Schema.Finite })
);

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
  const { aad } = Schema.decodeSync(SealedSchema)(bytes);
  const admitted = path.join(state, "admitted", `${aad.messageId}.json`);
  const uncertain = path.join(state, "uncertain");

  const left = existsSync(uncertain)
    ? Number(readFileSync(uncertain, "utf-8"))
    : 0;

  if (left > 0) {
    writeFileSync(uncertain, String(left - 1));
    fail(6, "Uncertain: no acknowledgement");
  }

  if (existsSync(admitted)) {
    const stored = Schema.decodeSync(AdmittedSchema)(
      readFileSync(admitted, "utf-8")
    );

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
