import assert from "node:assert/strict";
import {
  createShippingExportConfigFormData,
  parseShippingExportConfigFormData,
} from "./shippingExportConfigFormData";
import { DEFAULT_SHIPPING_EXPORT_CONFIG } from "../types/shippingExport";

type TestCase = {
  name: string;
  run: () => void;
};

const testCases: TestCase[] = [
  {
    name: "parseShippingExportConfigFormData defaults easypost mode to test",
    run: () => {
      const formData = new FormData();
      formData.append("defaultSellerKey", "8520a14f");
      formData.append("fromAddress.name", "Warehouse");
      formData.append("fromAddress.street1", "123 Main");
      formData.append("fromAddress.city", "Austin");
      formData.append("fromAddress.state", "TX");
      formData.append("fromAddress.zip", "78701");
      formData.append("fromAddress.country", "US");

      formData.append("letter.labelSize", "7x3");
      formData.append("letter.baseWeightOz", "1");
      formData.append("letter.perItemWeightOz", "0.1");
      formData.append("letter.maxItemCount", "24");
      formData.append("letter.maxValueUsd", "50");
      formData.append("letter.lengthIn", "9");
      formData.append("letter.widthIn", "4");
      formData.append("letter.heightIn", "0.25");

      formData.append("flat.labelSize", "4x6");
      formData.append("flat.baseWeightOz", "1");
      formData.append("flat.perItemWeightOz", "0.1");
      formData.append("flat.maxItemCount", "100");
      formData.append("flat.maxValueUsd", "50");
      formData.append("flat.lengthIn", "5");
      formData.append("flat.widthIn", "7");
      formData.append("flat.heightIn", "0.75");

      formData.append("parcel.labelSize", "4x6");
      formData.append("parcel.baseWeightOz", "1");
      formData.append("parcel.perItemWeightOz", "0.1");
      formData.append("parcel.lengthIn", "7");
      formData.append("parcel.widthIn", "9");
      formData.append("parcel.heightIn", "0.75");

      formData.append("labelFormat", "PDF");
      formData.append("combineOrders", "true");
      formData.append("expeditedService", "GroundAdvantage");

      const config = parseShippingExportConfigFormData(formData);
      assert.equal(config.defaultSellerKey, "8520a14f");
      assert.equal(config.easypostMode, "test");
    },
  },
  {
    name: "createShippingExportConfigFormData preserves easypost mode",
    run: () => {
      const formData = createShippingExportConfigFormData({
        ...DEFAULT_SHIPPING_EXPORT_CONFIG,
        defaultSellerKey: "seller-123",
        easypostMode: "production",
      });

      assert.equal(formData.get("defaultSellerKey"), "seller-123");
      assert.equal(formData.get("easypostMode"), "production");
    },
  },
];

let failures = 0;

for (const testCase of testCases) {
  try {
    testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`Passed ${testCases.length} shipping export config form-data tests.`);
}
