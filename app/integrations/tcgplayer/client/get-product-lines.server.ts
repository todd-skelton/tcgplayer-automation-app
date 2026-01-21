import { mpSearchApi } from "../../../core/clients";

export interface ProductLine {
  productLineId: number;
  productLineName: string;
  productLineUrlName: string;
  isDirect: boolean;
}

export async function getProductLines(): Promise<ProductLine[]> {
  return mpSearchApi.get<ProductLine[]>("/v1/search/productLines");
}
