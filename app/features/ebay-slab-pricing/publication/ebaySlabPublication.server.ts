import {
  createSellerRequestsForRun,
  sellerOAuthConfigured,
} from "../inventory/ebaySellerRequest.server";
import { createEbaySlabPricePublisher } from "./ebaySlabPricePublisher.server";
export const sellerPublicationStatus = () => ({
  sellerConfigured: sellerOAuthConfigured(),
  reviewedWritesEnabled:
    sellerOAuthConfigured() &&
    process.env.EBAY_SLAB_PUBLISHING_ENABLED === "true",
});
export const ebaySlabPublisher = () =>
  createEbaySlabPricePublisher(createSellerRequestsForRun());
