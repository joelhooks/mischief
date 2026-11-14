import { webCrypto } from "@mischief/plan-run";
import { Crypto, Effect } from "effect";

export const freshPeonId = Crypto.Crypto.use((service) =>
  service.randomUUIDv4()
).pipe(Effect.provide(webCrypto), Effect.orDie);

export const hashPeonText = (text: string) =>
  Crypto.Crypto.use((service) =>
    service.digest("SHA-256", new TextEncoder().encode(text))
  ).pipe(
    Effect.provide(webCrypto),
    Effect.orDie,
    Effect.map((hash) =>
      [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    )
  );
