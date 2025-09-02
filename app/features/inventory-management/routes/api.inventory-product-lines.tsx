import { data } from "react-router";
import { productLinesDb } from "../../../datastores";

export async function loader() {
  try {
    const productLines = await productLinesDb.find({});
    return data(productLines, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
