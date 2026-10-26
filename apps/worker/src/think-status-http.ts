import { toHttpApi } from "@mischief/capability/http-api";
import { thinkingCapabilities, ThinkTelemetry } from "@mischief/core";
import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

const http = toHttpApi("Mischief thinking", thinkingCapabilities);

export const thinkStatusHttp = (telemetry: ThinkTelemetry["Service"]) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(http.api).pipe(
      Layer.provide(http.layer),
      Layer.provide(
        Layer.merge(
          Layer.succeed(ThinkTelemetry, telemetry),
          HttpServer.layerServices
        )
      )
    ),
    { disableLogger: true }
  );
