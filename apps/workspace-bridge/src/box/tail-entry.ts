import {
  clipTailText,
  peonTailArgBudget,
  peonTailEntryBudget,
  peonTailLastToolLimit,
  peonTailNameBudget,
  previewTailText,
  sanitizeTailText,
  tailJsonBytes,
} from "@mischief/core";
import type { PeonTailEntry, PeonTailEntryType } from "@mischief/core";
import { Option, Predicate, Schema } from "effect";

const RawEntry = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown)
);

const Entry = Schema.Struct({
  type: Schema.String,
  message: Schema.optionalKey(
    Schema.Struct({
      role: Schema.Literals(["assistant", "system", "toolResult", "user"]),
      content: Schema.optionalKey(
        Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])
      ),
    })
  ),
});

const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const CallBlock = Schema.Struct({
  type: Schema.Literal("toolCall"),
  name: Schema.String,
  arguments: Schema.JsonObject,
});

const protectedFields =
  /^(?:env(?:ironment)?|headers?|auth(?:entication|orization)?|credentials?|(?:set[-_])?cookies?)$/iu;

const metadataFields = /^(?:details|metadata)$/iu;

const credentialField =
  /(?:api[-_]?key|token|password|secret|private[-_]?key|model[-_]?route[-_]?key|database[-_]?url)$/iu;

const containsProtectedFields = ({
  value,
  depth,
}: {
  readonly value: unknown;
  readonly depth: number;
}): boolean => {
  if (!Predicate.isObjectOrArray(value)) {
    return false;
  }

  if (depth >= 16) {
    return true;
  }

  return Object.entries(value).some(
    ([key, child]) =>
      protectedFields.test(sanitizeTailText(key)) ||
      containsProtectedFields({ value: child, depth: depth + 1 })
  );
};

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
  Array.isArray(value);

const safeArgument = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) {
    return sanitizeTailText(value);
  }

  if (isJsonArray(value)) {
    return value.map(safeArgument);
  }

  if (
    value === null ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const safeKey = sanitizeTailText(key);

      return metadataFields.test(safeKey) || protectedFields.test(safeKey)
        ? []
        : [
            [
              safeKey,
              credentialField.test(safeKey)
                ? "[redacted]"
                : safeArgument(child),
            ],
          ];
    })
  );
};

type TailEntry = typeof PeonTailEntry.Type;

type ToolPreview = NonNullable<TailEntry["toolCalls"]>[number];

type EntryValue = typeof Entry.Type;

const entryType = (
  { type, message }: EntryValue,
  bytes: number
): typeof PeonTailEntryType.Type => {
  if (
    type === "session" ||
    type === "compaction" ||
    type === "model_change" ||
    type === "thinking_level_change"
  ) {
    return type;
  }

  if (type === "message" && message !== undefined) {
    return message.role === "assistant" &&
      Predicate.isString(message.content) &&
      bytes > peonTailEntryBudget
      ? "blob"
      : message.role;
  }

  return bytes > peonTailEntryBudget ? "blob" : "other";
};

const previewEntry = (
  base: TailEntry,
  message: NonNullable<EntryValue["message"]>
): TailEntry => {
  if (message.content === undefined) {
    return base;
  }

  if (Predicate.isString(message.content)) {
    return message.role === "user"
      ? {
          ...base,
          text: previewTailText(
            message.content,
            peonTailEntryBudget - tailJsonBytes(JSON.stringify(base)) - 8
          ),
        }
      : base;
  }

  const textParts: string[] = [];
  const toolCalls: ToolPreview[] = [];
  let callBudget = peonTailEntryBudget - 512;

  for (const block of message.content) {
    const text = Schema.decodeUnknownOption(TextBlock)(block);

    if (Option.isSome(text)) {
      textParts.push(text.value.text);
      continue;
    }

    if (
      message.role !== "assistant" ||
      toolCalls.length >= peonTailLastToolLimit
    ) {
      continue;
    }

    const call = Schema.decodeUnknownOption(CallBlock)(block);

    if (Option.isNone(call)) {
      continue;
    }

    const preview = {
      name: previewTailText(call.value.name, peonTailNameBudget),
      args: clipTailText(
        JSON.stringify(safeArgument(call.value.arguments)),
        peonTailArgBudget
      ),
    };

    const size = tailJsonBytes(JSON.stringify(preview)) + 1;

    if (size <= callBudget) {
      toolCalls.push(preview);
      callBudget -= size;
    }
  }

  const entry = toolCalls.length === 0 ? base : { ...base, toolCalls };
  const text = sanitizeTailText(textParts.join(""));

  return text.length === 0
    ? entry
    : {
        ...entry,
        text: clipTailText(
          text,
          peonTailEntryBudget - tailJsonBytes(JSON.stringify(entry)) - 8
        ),
      };
};

export const summarizeTailEntry = (line: Buffer, id: string): TailEntry => {
  const bytes = line.length;
  const raw = Schema.decodeOption(RawEntry)(line.toString("utf-8"));

  if (Option.isNone(raw)) {
    return { bytes, id, type: bytes > peonTailEntryBudget ? "blob" : "other" };
  }

  const parsed = Schema.decodeUnknownOption(Entry)(raw.value);

  if (Option.isNone(parsed)) {
    return { bytes, id, type: bytes > peonTailEntryBudget ? "blob" : "other" };
  }

  const { message } = parsed.value;
  const type = entryType(parsed.value, bytes);
  const base = { bytes, id, type };

  if (
    (type !== "assistant" && type !== "user") ||
    message === undefined ||
    containsProtectedFields({ value: raw.value, depth: 0 })
  ) {
    return base;
  }

  return previewEntry(base, message);
};
