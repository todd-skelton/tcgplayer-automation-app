import { data } from "react-router";

export async function loader() {
  try {
    // Return empty array since we no longer store current inventory
    // TCGPlayer is the source of truth for current inventory
    return data([], { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    // No longer saving inventory entries to database
    // This endpoint is kept for compatibility but doesn't do anything
    return data(
      {
        message: "Inventory entries are no longer saved to database",
        entries: [],
      },
      { status: 200 }
    );
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
