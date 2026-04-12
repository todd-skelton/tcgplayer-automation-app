import { orderManagementApi } from "~/core/clients";

export interface ExportPullSheetRequest {
  orderNumbers: string[];
  timezoneOffset: number;
}

export async function exportPullSheet(
  request: ExportPullSheetRequest,
): Promise<string> {
  return orderManagementApi.post<string>(
    "/orders/pull-sheets/export?api-version=2.0",
    request,
  );
}
