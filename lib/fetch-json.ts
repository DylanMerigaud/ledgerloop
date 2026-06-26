import type { z } from "zod";

import { isRecord } from "@/lib/assert";

/**
 * Typed POST → JSON for our own API routes. The `fetch` body is `any`; instead of
 * asserting its shape (`res.json() as T`), we VALIDATE it against a Zod schema, so
 * the type is earned at runtime — a malformed response fails loudly here, not as a
 * mystery `undefined` three components deep.
 *
 * On a non-2xx response it reads `{ error }` (our routes' error shape) and throws
 * `FetchJsonError` with that message + status, so callers show the server's reason.
 */

export class FetchJsonError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FetchJsonError";
  }
}

const errorMessage = (body: unknown, fallback: string): string => {
  if (isRecord(body) && typeof body["error"] === "string") return body["error"];
  return fallback;
};

/** POST `body` to `url`, parse the response with `schema`, return the typed value. */
export const postJson = async <T>(
  url: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> => {
  const res = await fetch(url, {
    method: "POST",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new FetchJsonError(
      errorMessage(json, `Request failed (${res.status}).`),
      res.status,
    );
  }
  return schema.parse(json);
};
