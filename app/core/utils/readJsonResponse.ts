/**
 * Reads API responses in the browser without crashing on bodies that are not
 * JSON. Proxies in front of the app (Tailscale, Docker) answer with an empty
 * body and a 5xx status when a request never reaches the app, and calling
 * `response.json()` on that throws an unhelpful "Unexpected end of JSON input".
 * These helpers read the body as text first and name the HTTP status instead.
 */

/** Reads a JSON payload, throwing a readable error for any failed response. */
export async function readJsonResponse<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    throw new Error(describeFailure(response, text, payload, fallbackMessage));
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(
      `${fallbackMessage} The server returned an unreadable response (HTTP ${response.status}).`,
    );
  }

  return payload as T;
}

/** Builds the error message for a failed response whose body is otherwise unused. */
export async function readResponseError(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text();
  return describeFailure(response, text, parseJson(text), fallbackMessage);
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function describeFailure(
  response: Response,
  text: string,
  payload: unknown,
  fallbackMessage: string,
): string {
  const payloadError =
    payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: unknown }).error
      : undefined;

  if (typeof payloadError === "string" && payloadError.trim().length > 0) {
    return payloadError;
  }

  const status = response.statusText
    ? `HTTP ${response.status} ${response.statusText}`
    : `HTTP ${response.status}`;

  if (text.trim().length === 0) {
    return `${fallbackMessage} The server returned ${status} with an empty response, so the request may not have reached the app. Check that the app is running and try again.`;
  }

  return `${fallbackMessage} The server returned ${status}.`;
}
