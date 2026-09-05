import { data } from "react-router";
import { ProviderRequestError } from "../connections/providerRequest.server";
import { CONNECTION_MESSAGES } from "../connections/providerConnection";
import { SlabIdentityError } from "../identity/slabIdentity";
import { slabIdentityService } from "../identity/slabIdentities.server";

export function createSlabIdentityAction(service = slabIdentityService) {
  return async ({ request }: { request: Request }) => {
    const respond = (body: unknown, status = 200) =>
      data(body, { status, headers: { "Cache-Control": "no-store" } });
    if (request.method !== "POST")
      return respond({ error: "Method not allowed." }, 405);
    if (request.headers.get("Origin") !== new URL(request.url).origin)
      return respond(
        { error: "Submit this request from the application." },
        403,
      );
    try {
      const input = await request.json();
      if (!input || typeof input !== "object")
        throw new SlabIdentityError(
          "invalid-input",
          "Provide an identity request.",
        );
      const certificate = {
        grader: input.grader,
        certificateNumber: input.certificateNumber,
      };
      if (input.intent === "lookup") {
        if (
          input.expected !== undefined &&
          (!input.expected ||
            typeof input.expected !== "object" ||
            Array.isArray(input.expected))
        ) {
          throw new SlabIdentityError(
            "invalid-input",
            "Expected card fields must be an object.",
          );
        }
        return respond(
          await service.lookup(certificate, {
            expected: input.expected,
            refresh: input.refresh === true,
            signal: request.signal,
          }),
        );
      }
      if (input.intent === "confirm")
        return respond({
          record: await service.confirm(
            certificate,
            input.revision,
            input.identity,
            input.note,
          ),
        });
      throw new SlabIdentityError("invalid-input", "Choose lookup or confirm.");
    } catch (error) {
      if (error instanceof SlabIdentityError)
        return respond(
          { error: error.message, code: error.code },
          error.code === "conflict" ? 409 : 400,
        );
      if (error instanceof ProviderRequestError)
        return respond(
          { error: CONNECTION_MESSAGES[error.status], code: error.status },
          503,
        );
      if (error instanceof SyntaxError)
        return respond({ error: "Provide valid JSON." }, 400);
      return respond(
        { error: "Unable to resolve the identity. Try again." },
        500,
      );
    }
  };
}
