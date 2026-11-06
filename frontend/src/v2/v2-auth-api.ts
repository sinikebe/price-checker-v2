import { requestJson } from "./v2-http";

export type V2User = {
  id: number;
  username: string;
  role: "admin" | "confirmed" | "visitor";
};
export type V2AuthStatus = {
  admin_initialized: boolean;
  user: V2User | null;
};

export const authRequest = <T>(path: string, method = "GET", body?: object): Promise<T> =>
  requestJson<T>("/api/v2/auth/" + path, { method, body, fallback: "L'opération a échoué." });
