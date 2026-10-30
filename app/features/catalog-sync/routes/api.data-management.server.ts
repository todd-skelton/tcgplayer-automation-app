import { data } from "react-router";
import { runCatalogMaintenance } from "../services/catalogMaintenance.server";

// A Data Management job a server-drawn screen asks for, posted as JSON with the React form's
// field names: `{ "actionType": "syncNewProducts", "categoryId": "3" }`. It answers as the form's
// action does, `{ message }` or `{ error }` with the job's status.
export async function action({ request }: { request: Request }) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST")
    return data({ error: "Method not allowed." }, { status: 405, headers });
  let fields: Record<string, unknown>;
  try {
    fields = (await request.json()) as Record<string, unknown>;
  } catch {
    return data({ error: "Send the job as JSON." }, { status: 400, headers });
  }
  const { status, body } = await runCatalogMaintenance((name) => {
    const value = fields[name];
    return typeof value === "string" ? value : null;
  });
  return data(body, { status, headers });
}
