import { data } from "react-router";
import { categorySetsDb } from "~/datastores.server";

export async function loader({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    const productLineId = url.searchParams.get("productLineId");

    if (!productLineId) {
      return data({ error: "productLineId is required" }, { status: 400 });
    }

    const sets = await categorySetsDb.find({
      categoryId: Number(productLineId),
    });
    return data(sets, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
