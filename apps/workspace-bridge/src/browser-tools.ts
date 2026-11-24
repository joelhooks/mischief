import { Predicate, Schema } from "effect";

export class BrowserToolRefused extends Schema.TaggedError<
  BrowserToolRefused,
  { readonly brand: unique symbol }
>()("BrowserToolRefused", {
  field: Schema.String,
  message: Schema.String,
  received: Schema.String,
  status: Schema.Literal(403),
}) {}

const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);

const ArrayValue = Schema.Array(Schema.Unknown);

const EncryptedReasoningOnly = Schema.Tuple([
  Schema.Literal("reasoning.encrypted_content"),
]);

const ResponsesTool = Schema.Literals(["function", "custom"]);

const ResponsesChoiceMode = Schema.Literals(["auto", "none", "required"]);

const MessagesChoiceMode = Schema.Literals(["auto", "none", "any"]);

const isObject = Schema.is(ObjectValue);

const isArray = Schema.is(ArrayValue);

const isResponsesTool = Schema.is(ResponsesTool);

type BodyValue = (typeof ObjectValue.Type)[string];

const fieldKind = (value: BodyValue) => {
  if (value === undefined) {
    return "missing";
  }

  if (value === null) {
    return "null";
  }

  if (isArray(value)) {
    return "array";
  }

  if (Predicate.isString(value)) {
    return "string";
  }

  if (Predicate.isBoolean(value)) {
    return "boolean";
  }

  return Predicate.isNumber(value) ? "number" : "object";
};

const refuse = (field: string, received: string) =>
  new BrowserToolRefused({
    field,
    message: `Refused ${field} (${JSON.stringify(received)}): browser boxes accept only client-defined function tools. Remove that field or select a declared client tool and retry.`,
    received,
    status: 403,
  });

const refuseType = (field: string, type: BodyValue) =>
  refuse(
    field,
    Predicate.isString(type) ? type.slice(0, 128) : fieldKind(type)
  );

const responsesTranscript = new Set([
  "message",
  "input_text",
  "input_image",
  "output_text",
  "refusal",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
]);

const messagesTranscript = new Set([
  "text",
  "image",
  "document",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "tool_result",
]);

const transcriptRefusal = (
  body: typeof ObjectValue.Type,
  messages: boolean
) => {
  const field = messages ? "messages" : "input";
  const types = messages ? messagesTranscript : responsesTranscript;
  const stack = [{ path: field, value: body[field] }];

  while (stack.length > 0) {
    const entry = stack.pop();

    if (entry === undefined) {
      break;
    }

    const { path, value } = entry;

    if (isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ path: `${path}[${index}]`, value: value[index] });
      }
    } else if (isObject(value)) {
      for (const key of ["tools", "mcp_servers", "tool_choice"]) {
        if (Object.hasOwn(value, key)) {
          return refuse(`${path}.${key}`, fieldKind(value[key]));
        }
      }

      if (
        value.type === undefined
          ? !Predicate.isString(value.role)
          : !Predicate.isString(value.type) || !types.has(value.type)
      ) {
        return refuseType(`${path}.type`, value.type);
      }

      for (const key of ["output", "content"]) {
        if (Object.hasOwn(value, key)) {
          stack.push({ path: `${path}.${key}`, value: value[key] });
        }
      }
    }
  }

  return null;
};

const choiceRefusal = (
  body: typeof ObjectValue.Type,
  tools: typeof ArrayValue.Type,
  messages: boolean
) => {
  const choice = body.tool_choice;

  if (
    choice === undefined ||
    (!messages && Schema.is(ResponsesChoiceMode)(choice))
  ) {
    return null;
  }

  if (!isObject(choice)) {
    return refuseType("tool_choice", choice);
  }

  const { name, type } = choice;
  const named = messages ? type === "tool" : isResponsesTool(type);

  if (!named && !(messages && Schema.is(MessagesChoiceMode)(type))) {
    return refuseType("tool_choice.type", type);
  }

  for (const key of Object.keys(choice)) {
    if (
      key !== "type" &&
      !(named && key === "name") &&
      !(
        messages &&
        type !== "none" &&
        key === "disable_parallel_tool_use" &&
        Predicate.isBoolean(choice[key])
      )
    ) {
      return refuse(`tool_choice.${key}`, fieldKind(choice[key]));
    }
  }

  if (
    named &&
    (!Predicate.isString(name) ||
      !tools.some(
        (tool) =>
          isObject(tool) &&
          tool.name === name &&
          (messages || tool.type === type)
      ))
  ) {
    return refuseType("tool_choice.name", type);
  }

  return null;
};

export const browserToolRefusal = (
  body: typeof ObjectValue.Type,
  messages: boolean
) => {
  const forbidden = messages
    ? ["mcp_servers", "background", "container"]
    : [
        "mcp_servers",
        "background",
        "prompt",
        "previous_response_id",
        "conversation",
      ];

  for (const field of forbidden) {
    if (Object.hasOwn(body, field)) {
      return refuse(field, fieldKind(body[field]));
    }
  }

  if (!messages) {
    if (Object.hasOwn(body, "store") && body.store !== false) {
      return refuse("store", fieldKind(body.store));
    }

    if (
      Object.hasOwn(body, "include") &&
      !Schema.is(EncryptedReasoningOnly)(body.include)
    ) {
      return refuse("include", fieldKind(body.include));
    }
  }

  const tools = Object.hasOwn(body, "tools") ? body.tools : [];

  if (!isArray(tools)) {
    return refuse("tools", fieldKind(tools));
  }

  for (const [index, tool] of tools.entries()) {
    if (!isObject(tool)) {
      return refuse(`tools[${index}]`, fieldKind(tool));
    }

    if (
      messages
        ? Object.hasOwn(tool, "type") && tool.type !== "custom"
        : !isResponsesTool(tool.type)
    ) {
      return refuseType(`tools[${index}].type`, tool.type);
    }
  }

  return (
    choiceRefusal(body, tools, messages) ?? transcriptRefusal(body, messages)
  );
};
