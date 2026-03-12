import { data } from "react-router";
import { productLinesRepository } from "~/core/db";

export async function loader() {
  try {
    const productLines = await productLinesRepository.findAll();
    return data(productLines, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
