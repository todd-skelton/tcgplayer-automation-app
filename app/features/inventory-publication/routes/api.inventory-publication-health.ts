import { data } from "react-router";
import {
  inventoryPublicationSettingsRepository,
  inventoryPublicationsRepository,
} from "~/core/db";

export async function loader() {
  try {
    const [configuration, queue] = await Promise.all([
      inventoryPublicationSettingsRepository.get(),
      inventoryPublicationsRepository.getQueueHealth(),
    ]);
    return data({ configuration, queue });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
