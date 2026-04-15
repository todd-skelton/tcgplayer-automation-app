import { exportPackingSlips } from "~/integrations/tcgplayer/client/export-packing-slips.server";

type ShippingPackingSlipsExportActionDependencies = {
  exportPackingSlips?: typeof exportPackingSlips;
  now?: () => Date;
};

function normalizeOrderNumbers(orderNumbers: unknown): string[] {
  if (!Array.isArray(orderNumbers)) {
    return [];
  }

  return [
    ...new Set(
      orderNumbers
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function buildPackingSlipsFileName(now: Date): string {
  return `packing-slips-${now.toISOString().replace(/[:.]/g, "-")}.pdf`;
}

function toResponsePdfBody(pdfBytes: Uint8Array): Blob {
  const bodyBytes = new Uint8Array(pdfBytes);
  return new Blob([bodyBytes.buffer], { type: "application/pdf" });
}

export function createShippingPackingSlipsExportAction(
  dependencies: ShippingPackingSlipsExportActionDependencies = {},
) {
  const exportFn = dependencies.exportPackingSlips ?? exportPackingSlips;
  const getNow = dependencies.now ?? (() => new Date());

  return async function action({ request }: { request: Request }) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const payload = (await request.json()) as {
        orderNumbers?: unknown;
        timezoneOffset?: unknown;
      };

      const orderNumbers = normalizeOrderNumbers(payload.orderNumbers);
      const timezoneOffset =
        typeof payload.timezoneOffset === "number" &&
        Number.isFinite(payload.timezoneOffset)
          ? payload.timezoneOffset
          : null;

      if (orderNumbers.length === 0) {
        return Response.json(
          { error: "orderNumbers must include at least one order number." },
          { status: 400 },
        );
      }

      if (timezoneOffset === null) {
        return Response.json(
          { error: "timezoneOffset must be a valid number." },
          { status: 400 },
        );
      }

      const pdfBytes = await exportFn({
        orderNumbers,
        timezoneOffset,
      });

      return new Response(toResponsePdfBody(pdfBytes), {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="${buildPackingSlipsFileName(getNow())}"`,
          "Content-Type": "application/pdf",
        },
      });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  };
}
