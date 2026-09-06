import { SlabPublisherError } from "./slabPublication";
// A misbehaving adapter cannot leave an operator request waiting indefinitely.
export async function publicationRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 25000,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25000)
    throw new SlabPublisherError("unavailable");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SlabPublisherError("unavailable"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
