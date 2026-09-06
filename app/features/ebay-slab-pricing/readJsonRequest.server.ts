export async function readSlabJsonRequest(request: Request, maxBytes: number) {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new SyntaxError("Provide a JSON request.");
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("Provide a JSON request.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SyntaxError("Request is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
