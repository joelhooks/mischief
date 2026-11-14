// @effect-diagnostics asyncFunction:off -- Durable Object registry RPC methods are Promise APIs.
import {
  builtinPeonTemplates,
  mergePeonTemplate,
  peonTemplateReference,
  PeonId,
  PeonIndexEntry,
  PeonRefused,
  PeonTemplateRef,
  PeonTemplateVersion,
} from "@mischief/core";
import type {
  listPeonsContract,
  listPeonTemplatesContract,
  savePeonTemplateContract,
} from "@mischief/core";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";

import { listedPeonStates, peonMatches } from "./peon-list.js";
import type { Env } from "./plan-run-object.js";

const Row = Schema.Struct({ value: Schema.String });

const decodeRow = Schema.decodeUnknownSync(Row);

const decodeId = Schema.decodeUnknownSync(PeonId);

const decodeIndex = Schema.decodeUnknownSync(PeonIndexEntry);

const decodeVersion = Schema.decodeUnknownSync(
  Schema.fromJsonString(PeonTemplateVersion)
);

const decodeEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(PeonIndexEntry)
);

const registryFailure = (reason: string) => new PeonRefused({ reason });

export class PeonTemplates extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS peon_templates (name TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(name, version))"
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS peon_registry (id TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );

    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS peon_registry_owner_id ON peon_registry (json_extract(value, '$.owner'), id)"
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS peon_registry_owner_state_id ON peon_registry (json_extract(value, '$.owner'), json_extract(value, '$.state'), id)"
    );

    for (const version of builtinPeonTemplates) {
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO peon_templates VALUES (?, ?, ?)",
        version.name,
        version.version,
        JSON.stringify(version)
      );
    }
  }

  async resolve(ref: typeof PeonTemplateRef.Type) {
    return await Effect.runPromise(this.resolveEffect(ref));
  }

  private resolveEffect(ref: typeof PeonTemplateRef.Type) {
    return Effect.gen({ self: this }, function* resolveTemplate() {
      const valid = yield* Schema.decodeUnknownEffect(PeonTemplateRef)(
        ref
      ).pipe(
        Effect.mapError(() =>
          registryFailure(
            "Invalid template reference. Use listPeonTemplates and pass its name and version to spawnPeon."
          )
        )
      );

      const rows =
        valid.version === undefined
          ? this.ctx.storage.sql
              .exec(
                "SELECT value FROM peon_templates WHERE name = ? ORDER BY version DESC LIMIT 1",
                valid.name
              )
              .toArray()
          : this.ctx.storage.sql
              .exec(
                "SELECT value FROM peon_templates WHERE name = ? AND version = ?",
                valid.name,
                valid.version
              )
              .toArray();

      const found = Option.fromUndefinedOr(rows[0]);

      if (Option.isNone(found)) {
        return yield* registryFailure(
          `Unknown template ${valid.name}@${valid.version ?? "latest"}. Use listPeonTemplates, then retry spawnPeon with a listed version.`
        );
      }

      return decodeVersion(decodeRow(found.value).value);
    });
  }

  private writable() {
    if (this.env.MISCHIEF_PEON_BOXES !== "on") {
      throw registryFailure(
        "MISCHIEF_PEON_BOXES is off; changing peon intent would bypass host authorization. Ask the desk to turn the flag on, then retry the write."
      );
    }
  }

  async save(input: typeof savePeonTemplateContract.input.Type) {
    this.writable();

    return await Effect.runPromise(
      Effect.gen({ self: this }, function* saveTemplate() {
        const parent = yield* this.resolveEffect(
          peonTemplateReference(input.extends)
        );

        const template = yield* mergePeonTemplate(
          parent.template,
          input.overrides
        );

        const [last] = this.ctx.storage.sql
          .exec(
            "SELECT value FROM peon_templates WHERE name = ? ORDER BY version DESC LIMIT 1",
            input.name
          )
          .toArray();

        const version =
          last === undefined
            ? 1
            : decodeVersion(decodeRow(last).value).version + 1;

        const saved = yield* Schema.decodeUnknownEffect(PeonTemplateVersion)({
          extends: { name: parent.name, version: parent.version },
          name: input.name,
          template,
          version,
        }).pipe(
          Effect.mapError(() =>
            registryFailure(
              "Invalid template name or resolved version. Use a lowercase kebab-case name up to 40 characters; retry savePeonTemplate."
            )
          )
        );

        this.ctx.storage.sql.exec(
          "INSERT INTO peon_templates VALUES (?, ?, ?)",
          saved.name,
          saved.version,
          JSON.stringify(saved)
        );

        return saved;
      })
    );
  }

  async templates(input: typeof listPeonTemplatesContract.input.Type) {
    return await Effect.runPromise(
      Effect.sync(() => {
        const limit = input.limit ?? 50;

        const rows = this.ctx.storage.sql
          .exec(
            "SELECT t.value FROM peon_templates t JOIN (SELECT name, MAX(version) version FROM peon_templates GROUP BY name) latest ON t.name = latest.name AND t.version = latest.version WHERE t.name > ? ORDER BY t.name LIMIT ?",
            input.cursor ?? "",
            limit + 1
          )
          .toArray();

        const templates = rows
          .slice(0, limit)
          .map((row) => decodeVersion(decodeRow(row).value));

        return {
          cursor: rows.length > limit ? (templates.at(-1)?.name ?? null) : null,
          templates,
        };
      })
    );
  }

  async lookup(peonId: string) {
    return await Effect.runPromise(
      Effect.sync(() => {
        const [row] = this.ctx.storage.sql
          .exec(
            "SELECT value FROM peon_registry WHERE id = ?",
            decodeId(peonId)
          )
          .toArray();

        return row === undefined ? null : decodeEntry(decodeRow(row).value);
      })
    );
  }

  async claim(entry: typeof PeonIndexEntry.Type) {
    this.writable();

    return await Effect.runPromise(
      Effect.gen({ self: this }, function* claimPeon() {
        const valid = yield* Schema.decodeUnknownEffect(PeonIndexEntry)(
          entry
        ).pipe(
          Effect.mapError(() =>
            registryFailure(
              "Invalid peon registry entry. Retry spawnPeon through the authenticated worker."
            )
          )
        );

        const [row] = this.ctx.storage.sql
          .exec("SELECT value FROM peon_registry WHERE id = ?", valid.peonId)
          .toArray();

        if (row !== undefined) {
          const previous = decodeEntry(decodeRow(row).value);

          if (previous.state === "destroyed") {
            return yield* registryFailure(
              `Peon ${valid.peonId} was destroyed at ${previous.destroyedAt}; reusing its id would revive old mail and workspace requests. Use spawnPeon or clonePeon with a fresh id; its template was ${previous.template.name}@${previous.template.version}.`
            );
          }

          if (
            previous.owner !== valid.owner ||
            previous.creationKey !== valid.creationKey
          ) {
            return yield* registryFailure(
              `Peon id ${valid.peonId} is already reserved; overwriting it would expose another caller's workspace. Retry spawnPeon with a different peonId.`
            );
          }

          return previous;
        }

        this.ctx.storage.sql.exec(
          "INSERT INTO peon_registry VALUES (?, ?)",
          valid.peonId,
          JSON.stringify(valid)
        );

        return valid;
      })
    );
  }

  async update(entry: typeof PeonIndexEntry.Type) {
    this.writable();
    await Effect.runPromise(
      Effect.sync(() => {
        const valid = decodeIndex(entry);

        const [row] = this.ctx.storage.sql
          .exec("SELECT value FROM peon_registry WHERE id = ?", valid.peonId)
          .toArray();

        const previous =
          row === undefined ? undefined : decodeEntry(decodeRow(row).value);

        if (previous?.state === "destroyed" && valid.state !== "destroyed") {
          throw registryFailure(
            `Peon ${valid.peonId} has a tombstone; a stale checkpoint cannot revive destroyed work. Use spawnPeon with a fresh id.`
          );
        }

        this.ctx.storage.sql.exec(
          "UPDATE peon_registry SET value = ? WHERE id = ?",
          JSON.stringify(valid),
          valid.peonId
        );
      })
    );
  }

  async list(input: typeof listPeonsContract.input.Type, owner: string) {
    return await Effect.runPromise(
      Effect.sync(() => {
        if (input.owner !== undefined && input.owner !== owner) {
          return { cursor: null, peons: [] };
        }

        const limit = input.limit ?? 50;
        const states = listedPeonStates(input.state);
        const parameters: (string | number)[] = [owner, input.cursor ?? ""];

        const templateClause =
          input.template === undefined
            ? ""
            : " AND json_extract(value, '$.template.name') = ?";

        const stateClause =
          states === null
            ? ""
            : " AND json_extract(value, '$.state') IN (SELECT value FROM json_each(?))";

        if (input.template !== undefined) {
          parameters.push(input.template);
        }

        if (states !== null) {
          parameters.push(JSON.stringify(states));
        }

        parameters.push(limit + 1);

        const rows = this.ctx.storage.sql
          .exec(
            `SELECT value FROM peon_registry WHERE json_extract(value, '$.owner') = ? AND id > ?${templateClause}${stateClause} ORDER BY id LIMIT ?`,
            ...parameters
          )
          .toArray();

        const scanned = rows
          .slice(0, limit)
          .map((row) => decodeEntry(decodeRow(row).value));

        const peons = scanned.filter((entry) =>
          peonMatches(entry, input, owner)
        );

        return {
          cursor: rows.length > limit ? (scanned.at(-1)?.peonId ?? null) : null,
          peons,
        };
      })
    );
  }
}
