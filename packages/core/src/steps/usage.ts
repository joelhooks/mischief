import type { ThinkReceipt } from "./receipt.js";

export interface Usage {
  readonly receipt?: ThinkReceipt;
  readonly tokens: number;
  readonly usd?: number;
}
