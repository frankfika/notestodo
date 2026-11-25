import { ulid } from "ulid";
import { type IdPrefix } from "@huoye/schema";

export function newId(prefix: IdPrefix): string {
  return `${prefix}${ulid().toLowerCase()}`;
}
