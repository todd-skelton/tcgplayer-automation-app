import {
  DEFAULT_SHIPPING_EXPORT_CONFIG,
  type EasyPostMode,
  type EasyPostService,
  type LabelFormat,
  type LabelSize,
  type ShippingExportConfig,
} from "../types/shippingExport";

function parseNumberFormValue(
  formData: FormData,
  key: string,
  fallback: number,
): number {
  const rawValue = formData.get(key);
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

function parseStringFormValue(
  formData: FormData,
  key: string,
  fallback = "",
): string {
  return String(formData.get(key) ?? fallback).trim();
}

export function parseShippingExportConfigFormData(
  formData: FormData,
): ShippingExportConfig {
  return {
    defaultSellerKey: parseStringFormValue(formData, "defaultSellerKey"),
    fromAddress: {
      name: parseStringFormValue(formData, "fromAddress.name"),
      company: parseStringFormValue(formData, "fromAddress.company") || undefined,
      phone: parseStringFormValue(formData, "fromAddress.phone") || undefined,
      email: parseStringFormValue(formData, "fromAddress.email") || undefined,
      street1: parseStringFormValue(formData, "fromAddress.street1"),
      street2: parseStringFormValue(formData, "fromAddress.street2") || undefined,
      city: parseStringFormValue(formData, "fromAddress.city"),
      state: parseStringFormValue(formData, "fromAddress.state"),
      zip: parseStringFormValue(formData, "fromAddress.zip"),
      country:
        parseStringFormValue(formData, "fromAddress.country", "US") || "US",
    },
    letter: {
      labelSize: parseStringFormValue(
        formData,
        "letter.labelSize",
        DEFAULT_SHIPPING_EXPORT_CONFIG.letter.labelSize,
      ) as LabelSize,
      baseWeightOz: parseNumberFormValue(
        formData,
        "letter.baseWeightOz",
        DEFAULT_SHIPPING_EXPORT_CONFIG.letter.baseWeightOz,
      ),
      perItemWeightOz: parseNumberFormValue(
        formData,
        "letter.perItemWeightOz",
        DEFAULT_SHIPPING_EXPORT_CONFIG.letter.perItemWeightOz,
      ),
      maxItemCount: parseNumberFormValue(
        formData,
        "letter.maxItemCount",
        DEFAULT_SHIPPING_EXPORT_CONFIG.letter.maxItemCount ?? 0,
      ),
      maxValueUsd: parseNumberFormValue(
        formData,
        "letter.maxValueUsd",
        DEFAULT_SHIPPING_EXPORT_CONFIG.letter.maxValueUsd ?? 0,
      ),
      lengthIn: parseNumberFormValue(
        formData,
        "letter.lengthIn",
        DEFAULT_SHIPPING_EXPORT_CONFIG.letter.lengthIn,
      ),
      widthIn: parseNumberFormValue(
        formData,
        "letter.widthIn",
        DEFAULT_SHIPPING_EXPORT_CONFIG.letter.widthIn,
      ),
      heightIn: parseNumberFormValue(
        formData,
        "letter.heightIn",
        DEFAULT_SHIPPING_EXPORT_CONFIG.letter.heightIn,
      ),
    },
    flat: {
      labelSize: parseStringFormValue(
        formData,
        "flat.labelSize",
        DEFAULT_SHIPPING_EXPORT_CONFIG.flat.labelSize,
      ) as LabelSize,
      baseWeightOz: parseNumberFormValue(
        formData,
        "flat.baseWeightOz",
        DEFAULT_SHIPPING_EXPORT_CONFIG.flat.baseWeightOz,
      ),
      perItemWeightOz: parseNumberFormValue(
        formData,
        "flat.perItemWeightOz",
        DEFAULT_SHIPPING_EXPORT_CONFIG.flat.perItemWeightOz,
      ),
      maxItemCount: parseNumberFormValue(
        formData,
        "flat.maxItemCount",
        DEFAULT_SHIPPING_EXPORT_CONFIG.flat.maxItemCount ?? 0,
      ),
      maxValueUsd: parseNumberFormValue(
        formData,
        "flat.maxValueUsd",
        DEFAULT_SHIPPING_EXPORT_CONFIG.flat.maxValueUsd ?? 0,
      ),
      lengthIn: parseNumberFormValue(
        formData,
        "flat.lengthIn",
        DEFAULT_SHIPPING_EXPORT_CONFIG.flat.lengthIn,
      ),
      widthIn: parseNumberFormValue(
        formData,
        "flat.widthIn",
        DEFAULT_SHIPPING_EXPORT_CONFIG.flat.widthIn,
      ),
      heightIn: parseNumberFormValue(
        formData,
        "flat.heightIn",
        DEFAULT_SHIPPING_EXPORT_CONFIG.flat.heightIn,
      ),
    },
    parcel: {
      labelSize: parseStringFormValue(
        formData,
        "parcel.labelSize",
        DEFAULT_SHIPPING_EXPORT_CONFIG.parcel.labelSize,
      ) as LabelSize,
      baseWeightOz: parseNumberFormValue(
        formData,
        "parcel.baseWeightOz",
        DEFAULT_SHIPPING_EXPORT_CONFIG.parcel.baseWeightOz,
      ),
      perItemWeightOz: parseNumberFormValue(
        formData,
        "parcel.perItemWeightOz",
        DEFAULT_SHIPPING_EXPORT_CONFIG.parcel.perItemWeightOz,
      ),
      lengthIn: parseNumberFormValue(
        formData,
        "parcel.lengthIn",
        DEFAULT_SHIPPING_EXPORT_CONFIG.parcel.lengthIn,
      ),
      widthIn: parseNumberFormValue(
        formData,
        "parcel.widthIn",
        DEFAULT_SHIPPING_EXPORT_CONFIG.parcel.widthIn,
      ),
      heightIn: parseNumberFormValue(
        formData,
        "parcel.heightIn",
        DEFAULT_SHIPPING_EXPORT_CONFIG.parcel.heightIn,
      ),
    },
    labelFormat: parseStringFormValue(
      formData,
      "labelFormat",
      DEFAULT_SHIPPING_EXPORT_CONFIG.labelFormat,
    ) as LabelFormat,
    combineOrders: String(formData.get("combineOrders")) === "true",
    expeditedService: parseStringFormValue(
      formData,
      "expeditedService",
      DEFAULT_SHIPPING_EXPORT_CONFIG.expeditedService,
    ) as EasyPostService,
    easypostMode: parseStringFormValue(
      formData,
      "easypostMode",
      DEFAULT_SHIPPING_EXPORT_CONFIG.easypostMode,
    ) as EasyPostMode,
  };
}

export function createShippingExportConfigFormData(
  config: ShippingExportConfig,
  actionType = "save",
): FormData {
  const formData = new FormData();

  formData.append("actionType", actionType);
  formData.append("defaultSellerKey", config.defaultSellerKey);
  formData.append("fromAddress.name", config.fromAddress.name);
  formData.append("fromAddress.company", config.fromAddress.company ?? "");
  formData.append("fromAddress.phone", config.fromAddress.phone ?? "");
  formData.append("fromAddress.email", config.fromAddress.email ?? "");
  formData.append("fromAddress.street1", config.fromAddress.street1);
  formData.append("fromAddress.street2", config.fromAddress.street2 ?? "");
  formData.append("fromAddress.city", config.fromAddress.city);
  formData.append("fromAddress.state", config.fromAddress.state);
  formData.append("fromAddress.zip", config.fromAddress.zip);
  formData.append("fromAddress.country", config.fromAddress.country);

  formData.append("letter.labelSize", config.letter.labelSize);
  formData.append("letter.baseWeightOz", String(config.letter.baseWeightOz));
  formData.append(
    "letter.perItemWeightOz",
    String(config.letter.perItemWeightOz),
  );
  formData.append("letter.maxItemCount", String(config.letter.maxItemCount ?? 0));
  formData.append("letter.maxValueUsd", String(config.letter.maxValueUsd ?? 0));
  formData.append("letter.lengthIn", String(config.letter.lengthIn));
  formData.append("letter.widthIn", String(config.letter.widthIn));
  formData.append("letter.heightIn", String(config.letter.heightIn));

  formData.append("flat.labelSize", config.flat.labelSize);
  formData.append("flat.baseWeightOz", String(config.flat.baseWeightOz));
  formData.append("flat.perItemWeightOz", String(config.flat.perItemWeightOz));
  formData.append("flat.maxItemCount", String(config.flat.maxItemCount ?? 0));
  formData.append("flat.maxValueUsd", String(config.flat.maxValueUsd ?? 0));
  formData.append("flat.lengthIn", String(config.flat.lengthIn));
  formData.append("flat.widthIn", String(config.flat.widthIn));
  formData.append("flat.heightIn", String(config.flat.heightIn));

  formData.append("parcel.labelSize", config.parcel.labelSize);
  formData.append("parcel.baseWeightOz", String(config.parcel.baseWeightOz));
  formData.append(
    "parcel.perItemWeightOz",
    String(config.parcel.perItemWeightOz),
  );
  formData.append("parcel.lengthIn", String(config.parcel.lengthIn));
  formData.append("parcel.widthIn", String(config.parcel.widthIn));
  formData.append("parcel.heightIn", String(config.parcel.heightIn));

  formData.append("labelFormat", config.labelFormat);
  formData.append("combineOrders", String(config.combineOrders));
  formData.append("expeditedService", config.expeditedService);
  formData.append("easypostMode", config.easypostMode);

  return formData;
}
