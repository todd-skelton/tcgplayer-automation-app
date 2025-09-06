import type { PricerSku, TcgPlayerListing } from "../../../core/types/pricing";
import type {
  DataSourceService,
  DataSourceConfig,
} from "../../../shared/services/dataSourceInterfaces";
import { CsvToPricerSkuConverter } from "../../file-upload/services/dataConverters";
import Papa from "papaparse";

export interface CSVDataSourceParams {
  file: File;
}

/**
 * Data source for CSV file uploads
 */
export class CSVDataSource implements DataSourceService<TcgPlayerListing> {
  private converter = new CsvToPricerSkuConverter();

  async fetchData(params: CSVDataSourceParams): Promise<TcgPlayerListing[]> {
    const csvText = await params.file.text();

    const results = Papa.parse<TcgPlayerListing>(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    return results.data;
  }

  async validateData(
    listings: TcgPlayerListing[]
  ): Promise<TcgPlayerListing[]> {
    // Filter out invalid entries
    return listings.filter((listing) => {
      const skuId = Number(listing["TCGplayer Id"]);
      return !isNaN(skuId) && skuId > 0;
    });
  }

  async convertToPricerSku(listings: TcgPlayerListing[]): Promise<PricerSku[]> {
    return await this.converter.convertToPricerSkus(listings);
  }
}
