import { data } from "react-router";
import { checkProviderConnection } from "./checkProviderConnection.server";
import {
  clearProviderConnection,
  saveProviderConnection,
} from "./providerConnections.server";
import { CONNECTION_MESSAGES, isSlabProvider } from "./providerConnection";
import { ProviderRequestError } from "./providerRequest.server";

export function createProviderConnectionsAction(
  dependencies = {
    save: saveProviderConnection,
    clear: clearProviderConnection,
    check: checkProviderConnection,
  },
) {
  return async ({ request }: { request: Request }) => {
    const respond = (result: { ok: boolean; message: string }, status = 200) =>
      data(result, { status, headers: { "Cache-Control": "no-store" } });
    if (request.method !== "POST")
      return respond({ ok: false, message: "Method not allowed." }, 405);
    if (request.headers.get("Origin") !== new URL(request.url).origin) {
      return respond(
        { ok: false, message: "Submit this form from the application." },
        403,
      );
    }
    try {
      const form = await request.formData();
      const provider = form.get("provider");
      const intent = form.get("intent");
      if (!isSlabProvider(provider))
        return respond(
          { ok: false, message: "Choose a supported provider." },
          400,
        );
      if (intent === "save") {
        const credential = form.get("credential");
        const userAgent = form.get("userAgent");
        if (
          typeof credential !== "string" ||
          (userAgent !== null && typeof userAgent !== "string")
        ) {
          return respond(
            { ok: false, message: "Enter a valid connection." },
            400,
          );
        }
        await dependencies.save(provider, credential, userAgent ?? "");
        return respond({ ok: true, message: CONNECTION_MESSAGES.unchecked });
      }
      if (intent === "clear") {
        await dependencies.clear(provider);
        return respond({ ok: true, message: "Connection removed." });
      }
      if (intent === "check") {
        await dependencies.check(provider, request.signal);
        return respond({ ok: true, message: CONNECTION_MESSAGES.connected });
      }
      return respond({ ok: false, message: "Choose a supported action." }, 400);
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        // A completed check can report unavailable access. Revalidate its stored status.
        return respond({
          ok: false,
          message: CONNECTION_MESSAGES[error.status],
        });
      }
      return respond(
        {
          ok: false,
          message:
            "Unable to update the connection. Check the input and try again.",
        },
        400,
      );
    }
  };
}
