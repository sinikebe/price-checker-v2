import { requestJson } from "./v2-http";

export const moderationRequest = <T>(path: string, method = "GET", body?: object): Promise<T> =>
  requestJson<T>("/api/v2/moderation" + path, { method, body, cache: "no-store", fallback: "Opération impossible." });
