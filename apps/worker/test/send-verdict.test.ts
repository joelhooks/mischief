import { expect, it } from "@effect/vitest";
import { MailboxClientError, SendOutcomes } from "@rat-king/mailbox-client";

import { verdictOf } from "../src/mailroom.js";

const rejected = (error: string, status: number) =>
  verdictOf(
    SendOutcomes.Rejected({
      error: new MailboxClientError({ error, reason: error, status }),
    })
  )._tag;

it("only the mailbox's own Conflict means the id is already stored; a lease refusal is retried and nothing else counts as sent", () => {
  expect(rejected("Conflict", 409)).toBe("Conflict");
  expect(rejected("LeaseMismatch", 409)).toBe("Uncertain");
  expect(rejected("InvalidTransition", 409)).toBe("Refused");
  expect(rejected("DocumentConflict", 409)).toBe("Refused");
  expect(rejected("Retired", 410)).toBe("Refused");
});
