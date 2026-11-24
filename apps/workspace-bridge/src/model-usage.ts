import { Option, Schema } from "effect";

const TokenCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })
);

const Usage = Schema.Struct({
  cache_creation_input_tokens: Schema.optionalKey(TokenCount),
  cache_read_input_tokens: Schema.optionalKey(TokenCount),
  input_tokens: Schema.optionalKey(TokenCount),
  output_tokens: Schema.optionalKey(TokenCount),
  total_tokens: Schema.optionalKey(TokenCount),
});

const WithUsage = Schema.Struct({ usage: Schema.optionalKey(Usage) });

const UsageFrame = Schema.fromJsonString(
  Schema.Struct({
    ...WithUsage.fields,
    message: Schema.optionalKey(WithUsage),
    response: Schema.optionalKey(WithUsage),
    type: Schema.optionalKey(Schema.String),
  })
);

const MAX_FRAME = 4 * 1024 * 1024;

export const estimatedTokens = (bytes: number) => Math.ceil(bytes / 4);

class UsageFrames {
  private readonly decoder = new TextDecoder();
  private line: string | undefined = "";
  private frame: string | undefined = "";
  private input = 0;
  private output = 0;
  private total: number | undefined;
  private inputReported = false;
  private outputReported = false;
  private terminal = false;
  private cacheWrite = 0;
  private cacheRead = 0;

  private readonly sse: boolean;

  constructor(sse: boolean) {
    this.sse = sse;
  }

  private apply(json: string) {
    const decoded = Schema.decodeOption(UsageFrame)(json);

    if (Option.isNone(decoded)) {
      return;
    }

    this.terminal ||= [
      "response.completed",
      "response.incomplete",
      "message_stop",
    ].some((event) => decoded.value.type === event);

    for (const usage of [
      decoded.value.usage,
      decoded.value.message?.usage,
      decoded.value.response?.usage,
    ]) {
      if (usage !== undefined) {
        if (usage.total_tokens !== undefined) {
          this.total = Math.max(this.total ?? 0, usage.total_tokens);
        }

        this.inputReported ||= usage.input_tokens !== undefined;
        this.outputReported ||= usage.output_tokens !== undefined;
        this.input = Math.max(this.input, usage.input_tokens ?? 0);
        this.output = Math.max(this.output, usage.output_tokens ?? 0);
        this.cacheWrite = Math.max(
          this.cacheWrite,
          usage.cache_creation_input_tokens ?? 0
        );
        this.cacheRead = Math.max(
          this.cacheRead,
          usage.cache_read_input_tokens ?? 0
        );
      }
    }
  }

  private flush() {
    if (this.frame !== undefined && this.frame !== "") {
      this.apply(this.frame);
    }

    this.frame = "";
  }

  private append(text: string) {
    if (this.frame !== undefined) {
      this.frame =
        this.frame.length + text.length > MAX_FRAME
          ? undefined
          : this.frame + text;
    }
  }

  private read(text: string) {
    if (!this.sse) {
      this.append(text);

      return;
    }

    const lines = text.split("\n");

    for (const [index, part] of lines.entries()) {
      if (this.line !== undefined) {
        this.line =
          this.line.length + part.length > MAX_FRAME
            ? undefined
            : this.line + part;
      }

      if (index === lines.length - 1) {
        break;
      }

      const line = this.line?.replace(/\r$/u, "");

      if (line === undefined) {
        this.frame = undefined;
      } else if (line === "") {
        this.flush();
      } else if (line.startsWith("data:")) {
        this.append(
          `${this.frame === "" ? "" : "\n"}${line.slice(5).replace(/^ /u, "")}`
        );
      }

      this.line = "";
    }
  }

  push(bytes: Uint8Array) {
    this.read(this.decoder.decode(bytes, { stream: true }));
  }

  end() {
    this.read(this.decoder.decode());

    if (this.sse) {
      this.read("\n");
    }

    this.flush();
  }

  complete() {
    return this.sse && this.terminal;
  }

  tokens(requestBytes: number, responseBytes: number, settled: boolean) {
    const reportedInput = this.input + this.cacheWrite + this.cacheRead;
    const estimateInput = estimatedTokens(requestBytes);
    const estimateOutput = estimatedTokens(responseBytes);

    if (settled) {
      return (
        this.total ??
        (this.inputReported ? reportedInput : estimateInput) +
          (this.outputReported ? this.output : estimateOutput)
      );
    }

    return Math.max(
      this.total ?? 0,
      Math.max(reportedInput, estimateInput) +
        Math.max(this.output, estimateOutput)
    );
  }
}

export const isEventStream = (contentType: string) =>
  contentType.toLowerCase().startsWith("text/event-stream");

export const usageFrames = (contentType: string) =>
  new UsageFrames(isEventStream(contentType));
