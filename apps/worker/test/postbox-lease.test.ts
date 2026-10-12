import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Option } from "effect";

import { leaseBook } from "../src/postbox-lease.js";

const DID = "did:web:mischief.worker.pi.ratking-fleet.invalid";

it("a lease the consume loop took outlives the isolate that took it, until it expires, and a renewal replaces it", () => {
  const storage = nodeSqlStorage(":memory:");

  expect(leaseBook(storage).held(0)).toStrictEqual(Option.none());

  leaseBook(storage).save({
    did: DID,
    expiresAt: 1000,
    generation: 3,
    leaseId: "3mxlease1",
  });

  const evicted = leaseBook(storage);

  expect(evicted.held(999)).toStrictEqual(
    Option.some({
      did: DID,
      expiresAt: 1000,
      generation: 3,
      leaseId: "3mxlease1",
    })
  );
  expect(evicted.held(1000)).toStrictEqual(Option.none());

  evicted.save({
    did: DID,
    expiresAt: 2000,
    generation: 4,
    leaseId: "3mxlease2",
  });

  expect(leaseBook(storage).held(1500)).toStrictEqual(
    Option.some({
      did: DID,
      expiresAt: 2000,
      generation: 4,
      leaseId: "3mxlease2",
    })
  );
});
