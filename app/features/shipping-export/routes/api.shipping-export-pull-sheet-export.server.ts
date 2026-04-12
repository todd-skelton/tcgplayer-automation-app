import { exportPullSheet } from "~/integrations/tcgplayer/client/export-pull-sheet.server";

type ShippingPullSheetExportActionDependencies = {
  exportPullSheet?: typeof exportPullSheet;
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

export function createShippingPullSheetExportAction(
  dependencies: ShippingPullSheetExportActionDependencies = {},
) {
  const exportFn = dependencies.exportPullSheet ?? exportPullSheet;

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

      const csvText = await exportFn({
        orderNumbers,
        timezoneOffset,
      });

      return new Response(csvText, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
        },
      });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  };
}
