import axios from "axios";

const apiClient = axios.create({
  baseURL: window.location.origin,
});

/** Pull a human-readable message out of a FastAPI error body (`detail`). */
function extractDetail(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const detail = (data as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{ loc, msg, type }, ...]
    return detail
      .map((d) =>
        d && typeof d === "object" && "msg" in d
          ? String((d as { msg: unknown }).msg)
          : String(d)
      )
      .join("; ");
  }
  return null;
}

// Surface the backend's error detail as error.message so every consumer that
// renders `error.message` shows something actionable instead of "Request failed
// with status code 4xx".
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const detail = extractDetail(error?.response?.data);
    if (detail) error.message = detail;
    return Promise.reject(error);
  }
);

export default apiClient;
