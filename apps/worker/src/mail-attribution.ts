import { callerName } from "@mischief/core";
import { Option } from "effect";

export const attributeMail = (objectName: string, body: string) => {
  const split = objectName.lastIndexOf("/");
  const did = split === -1 ? objectName : objectName.slice(0, split);
  const runId = objectName.slice(split + 1);
  const caller = Option.getOrElse(callerName(did), () => did);

  const text = body
    .replaceAll(/^Mischief caller: .*; run: .*\n?/gmu, "")
    .trimEnd();

  return `${text}\n\nMischief caller: ${caller}; run: ${runId}`;
};
