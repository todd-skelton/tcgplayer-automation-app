import { data } from "react-router";
import { inventoryFifoRepository } from "~/core/db";
import { getShippingExportConfig } from "~/features/shipping-export/config/shippingExportConfig.server";

const hasOffset=(value:string)=>/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)&&Number.isFinite(Date.parse(value));

export function createInventoryFifoAction(dependencies={repository:inventoryFifoRepository,getConfig:getShippingExportConfig}){
  return async({request}:{request:Request})=>{
    if(request.method!=="POST")return data({error:"Method not allowed"},{status:405});
    try{
      const payload=await request.json() as Record<string,unknown>;
      const configured=(await dependencies.getConfig()).defaultSellerKey.trim();
      const sellerKey=typeof payload.sellerKey==="string"?payload.sellerKey.trim():configured;
      if(!sellerKey||sellerKey!==configured)return data({error:"Seller key must match the configured seller."},{status:400});
      if(payload.action==="find_order"){
        if(typeof payload.orderNumber!=="string"||!payload.orderNumber.trim())throw new Error("Order number is required.");
        return data({lines:await dependencies.repository.findOrderAllocation(sellerKey,payload.orderNumber)});
      }
      if(payload.action==="list_holds")return data({holds:await dependencies.repository.listHolds(sellerKey,{
        ...(typeof payload.afterSku==="number"?{afterSku:payload.afterSku}:{}),
        ...(typeof payload.limit==="number"?{limit:payload.limit}:{})})});
      if(payload.action==="list_revisions"){
        if(typeof payload.lineId!=="string")throw new Error("FIFO line ID is required.");
        return data({revisions:await dependencies.repository.listLineRevisions({sellerKey,lineId:payload.lineId,
          ...(typeof payload.afterRevision==="number"?{afterRevision:payload.afterRevision}:{}),
          ...(typeof payload.limit==="number"?{limit:payload.limit}:{})})});
      }
      if(payload.action==="record_disposition"){
        if(typeof payload.requestId!=="string"||typeof payload.orderNumber!=="string"||typeof payload.skuId!=="string"||
          (payload.dispositionType!=="unfulfilled_cancellation"&&payload.dispositionType!=="physical_restock")||
          typeof payload.quantity!=="number"||typeof payload.sourceOrderRevision!=="number"||
          typeof payload.availableAt!=="string"||!hasOffset(payload.availableAt)||
          !payload.evidence||typeof payload.evidence!=="object"||Array.isArray(payload.evidence)||!Array.isArray(payload.sourceAllocations))
          throw new Error("Complete disposition identity, quantity, availability, lineage, and evidence are required.");
        return data({result:await dependencies.repository.recordDisposition({
          requestId:payload.requestId,sellerKey,orderNumber:payload.orderNumber,skuId:payload.skuId,
          dispositionType:payload.dispositionType,quantity:payload.quantity,sourceOrderRevision:payload.sourceOrderRevision,
          availableAt:new Date(payload.availableAt),evidence:payload.evidence as Record<string,unknown>,
          sourceAllocations:payload.sourceAllocations as Array<{supplyKey:string;receiptId:number;quantity:number}>,
        })});
      }
      if(payload.action==="supersede_disposition"){
        if(typeof payload.requestId!=="string"||typeof payload.dispositionId!=="string"||
          typeof payload.sourceOrderRevision!=="number"||typeof payload.confirmedAt!=="string"||!hasOffset(payload.confirmedAt)||
          !payload.evidence||typeof payload.evidence!=="object"||Array.isArray(payload.evidence))
          throw new Error("Complete correction identity and evidence are required.");
        return data({result:await dependencies.repository.supersedeDisposition({requestId:payload.requestId,sellerKey,
          dispositionId:payload.dispositionId,sourceOrderRevision:payload.sourceOrderRevision,
          confirmedAt:new Date(payload.confirmedAt),evidence:payload.evidence as Record<string,unknown>})});
      }
      if(payload.action==="record_quantity_correction"){
        if(typeof payload.requestId!=="string"||typeof payload.orderNumber!=="string"||typeof payload.skuId!=="string"||
          typeof payload.sourceOrderRevision!=="number"||typeof payload.availableAt!=="string"||!hasOffset(payload.availableAt)||
          !payload.evidence||typeof payload.evidence!=="object"||Array.isArray(payload.evidence)||!Array.isArray(payload.sourceAllocations))
          throw new Error("Complete quantity correction identity, time, source allocations, and evidence are required.");
        return data({result:await dependencies.repository.recordQuantityCorrection({requestId:payload.requestId,sellerKey,
          orderNumber:payload.orderNumber,skuId:payload.skuId,sourceOrderRevision:payload.sourceOrderRevision,
          availableAt:new Date(payload.availableAt),evidence:payload.evidence as Record<string,unknown>,
          sourceAllocations:payload.sourceAllocations as Array<{supplyKey:string;receiptId:number;quantity:number}>})});
      }
      if(payload.action==="replay")return data({result:await dependencies.repository.processNextReplay(sellerKey)});
      throw new Error("Unknown inventory FIFO action.");
    }catch(error){return data({error:String(error)},{status:409});}
  };
}

