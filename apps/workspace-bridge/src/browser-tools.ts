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

const isDataUrl = Schema.is(
  Schema.String.check(Schema.isPattern(/^data:[^,]*,/u))
);

const isUrlOrFileRefField = Schema.is(
  Schema.Literals(["url", "file_id", "file_url"])
);

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
    message: `Refused ${field} (${JSON.stringify(received)}): browser boxes accept only client-defined function tools. Remove that field, use inline asset data, or select a declared client tool and retry.`,
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

const assetReferenceRefusal = (
  body: typeof ObjectValue.Type,
  tools: typeof ArrayValue.Type
) => {
  const declaredTools = new Set(tools);

  const stack: { readonly path: string; readonly value: BodyValue }[] = [
    { path: "", value: body },
  ];

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
      const { source } = value;

      if (
        isObject(source) &&
        (source.type === "url" || source.type === "file")
      ) {
        return refuseType(
          path === "" ? "source.type" : `${path}.source.type`,
          source.type
        );
      }

      for (const [key, child] of Object.entries(value)) {
        const field = path === "" ? key : `${path}.${key}`;

        if (
          isUrlOrFileRefField(key) ||
          (key === "image_url" && !isDataUrl(child))
        ) {
          return refuse(field, fieldKind(child));
        }

        if (
          !declaredTools.has(value) ||
          (key !== "parameters" && key !== "input_schema")
        ) {
          stack.push({ path: field, value: child });
        }
      }
    }
  }

  return null;
};

const inlineAssetRefusal = (path: string, block: typeof ObjectValue.Type) => {
  const { image_url: imageUrl, source, type } = block;

  if (type === "input_image" && !isDataUrl(imageUrl)) {
    return refuse(`${path}.image_url`, fieldKind(imageUrl));
  }

  if (type === "image" || type === "document") {
    if (!isObject(source)) {
      return refuse(`${path}.source`, fieldKind(source));
    }

    if (
      source.type !== "base64" &&
      !(type === "document" && source.type === "text")
    ) {
      return refuseType(`${path}.source.type`, source.type);
    }
  }

  return null;
};

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

      const assetRefusal = inlineAssetRefusal(path, value);

      if (assetRefusal !== null) {
        return assetRefusal;
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
    choiceRefusal(body, tools, messages) ??
    assetReferenceRefusal(body, tools) ??
    transcriptRefusal(body, messages)
  );
};
