import { data, type LoaderFunctionArgs } from "react-router";
import { inventoryPublicationSettingsRepository } from "~/core/db";
import { loadReinvestmentTurnaround } from "../services/reinvestmentTurnaround.server";

export function createReinvestmentTurnaroundLoader(dependencies={
  findSellerKey:async ()=>(await inventoryPublicationSettingsRepository.get()).settings.continuousPricing.sellerKey,
  load:loadReinvestmentTurnaround,
}) {
  return async function reinvestmentTurnaroundLoader({request}:LoaderFunctionArgs) {
    try {
      const sellerKey=await dependencies.findSellerKey();
      const requested=new URL(request.url).searchParams.get("asOf");
      const asOf=requested?new Date(requested):undefined;
      if (asOf && Number.isNaN(asOf.getTime())) return data({error:"asOf must be a valid timestamp."},{status:400});
      return data(await dependencies.load(sellerKey,asOf));
    } catch (error) {
      console.error("Reinvestment turnaround API load failed",error);
      return data({error:"Reinvestment turnaround could not be rebuilt from complete current evidence."},{status:500});
    }
  };
}

export const loader=createReinvestmentTurnaroundLoader();
