import { orderManagementApi } from "~/core/clients";

export interface ExportPackingSlipsRequest {
  orderNumbers: string[];
  timezoneOffset: number;
}

function toPdfBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export async function exportPackingSlips(
  request: ExportPackingSlipsRequest,
): Promise<Uint8Array> {
  const pdfBytes = await orderManagementApi.post<ArrayBuffer | Uint8Array>(
    "/orders/packing-slips/export?api-version=2.0",
    {
      sortingType: "ByRelease",
      format: "Default",
      timezoneOffset: request.timezoneOffset,
      orderNumbers: request.orderNumbers,
    },
    {
      headers: {
        Accept: "application/pdf",
      },
      responseType: "arraybuffer",
    },
  );

  return toPdfBytes(pdfBytes);
}
