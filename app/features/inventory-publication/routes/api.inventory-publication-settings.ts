import { data } from "react-router";
import { inventoryPublicationSettingsRepository } from "~/core/db";
import { normalizeInventoryPublicationSettings } from "../services/inventoryPublicationSettings";

export async function loader() {
  try {
    return data(await inventoryPublicationSettingsRepository.get());
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method === "PUT") {
      const settings = normalizeInventoryPublicationSettings(
        await request.json(),
      );
      return data(await inventoryPublicationSettingsRepository.save(settings));
    }

    if (request.method === "POST") {
      const payload = (await request.json()) as { action?: unknown };
      if (payload.action !== "resume") {
        return data({ error: "Unsupported action." }, { status: 400 });
      }
      return data(await inventoryPublicationSettingsRepository.resume());
    }

    return data({ error: "Method not allowed." }, { status: 405 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
