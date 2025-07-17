import type { PricerSku } from "../types/pricing";

/**
 * Base interface for data sources that can provide pricing input
 */
export interface DataSourceService<TInput> {
  fetchData(params: any): Promise<TInput[]>;
  validateData(data: TInput[]): Promise<TInput[]>;
  convertToPricerSku(data: TInput[]): Promise<PricerSku[]>;
}

/**
 * Configuration for data source operations
 */
export interface DataSourceConfig {
  onProgress?: (current: number, total: number, status: string) => void;
  isCancelled?: () => boolean;
}
