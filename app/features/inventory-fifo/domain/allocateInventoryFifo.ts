export type FifoSupplyLot = {
  supplyKey: string;
  receiptId: number;
  dispositionId: string | null;
  quantityCorrectionId?: string | null;
  excludedLineKeys?: readonly string[];
  quantity: number;
  availableAt: string;
  fifoPrecedence: 0 | 1;
  intakeAt: string | null;
  marketValueTenThousandths: number | null;
};

export type FifoOrderLine = {
  lineKey: string;
  orderId: string;
  orderNumber: string;
  orderTime: string;
  quantity: number;
};

export type FifoAllocation = {
  supplyKey: string;
  receiptId: number;
  dispositionId: string | null;
  quantityCorrectionId: string | null;
  quantity: number;
  availableAt: string;
};

export type FifoLineResult = {
  lineKey: string;
  allocations: FifoAllocation[];
  requestedQuantity: number;
  matchedQuantity: number;
  unmatchedQuantity: number;
  priceKnownQuantity: number;
  intakeMarketTotalCents: number | null;
  dateKnownQuantity: number;
  weightedDaysHeld: number | null;
};

const millisecondsPerDay=24*60*60*1_000;

function compareText(left:string,right:string){return left<right?-1:left>right?1:0;}

function compareLots(left:FifoSupplyLot,right:FifoSupplyLot){
  if(left.fifoPrecedence!==right.fifoPrecedence) return left.fifoPrecedence-right.fifoPrecedence;
  if(left.intakeAt===null&&right.intakeAt!==null)return -1;
  if(left.intakeAt!==null&&right.intakeAt===null)return 1;
  return compareText(left.intakeAt??"",right.intakeAt??"")||
    left.receiptId-right.receiptId||compareText(left.supplyKey,right.supplyKey);
}

function compareLines(left:FifoOrderLine,right:FifoOrderLine){
  return compareText(left.orderTime,right.orderTime)||compareText(left.orderNumber,right.orderNumber)||
    compareText(left.orderId,right.orderId)||compareText(left.lineKey,right.lineKey);
}

function canonicalTime(value:string,name:string){
  if(!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))throw new Error(`${name} must include a UTC offset.`);
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed))throw new Error(`${name} must be a valid timestamp.`);
  return new Date(parsed).toISOString();
}

class LotHeap{
  private readonly values:FifoSupplyLot[]=[];
  get size(){return this.values.length;}
  push(value:FifoSupplyLot){
    this.values.push(value);
    for(let index=this.values.length-1;index>0;){
      const parent=Math.floor((index-1)/2);
      if(compareLots(this.values[parent]!,value)<=0)break;
      this.values[index]=this.values[parent]!;index=parent;this.values[index]=value;
    }
  }
  peek(){return this.values[0];}
  pop(){
    const first=this.values[0];const last=this.values.pop();
    if(this.values.length&&last){
      this.values[0]=last;
      for(let index=0;;){
        const left=index*2+1;const right=left+1;
        if(left>=this.values.length)break;
        const child=right<this.values.length&&compareLots(this.values[right]!,this.values[left]!)<0?right:left;
        if(compareLots(this.values[index]!,this.values[child]!)<=0)break;
        [this.values[index],this.values[child]]=[this.values[child]!,this.values[index]!];index=child;
      }
    }
    return first;
  }
}

export function allocateInventoryFifo(
  sourceLines:readonly FifoOrderLine[],
  sourceLots:readonly FifoSupplyLot[],
):FifoLineResult[]{
  for(const lot of sourceLots){
    if(!Number.isSafeInteger(lot.quantity)||lot.quantity<=0)throw new Error("FIFO supply quantities must be positive safe integers.");
    if(lot.marketValueTenThousandths!==null&&(!Number.isSafeInteger(lot.marketValueTenThousandths)||lot.marketValueTenThousandths<0))
      throw new Error("FIFO market values must be nonnegative integer ten-thousandths.");
  }
  for(const line of sourceLines)if(!Number.isSafeInteger(line.quantity)||line.quantity<0)
    throw new Error("FIFO order quantities must be nonnegative safe integers.");
  const remaining=new Map(sourceLots.map((lot)=>[lot.supplyKey,lot.quantity]));
  if(remaining.size!==sourceLots.length)throw new Error("FIFO supply keys must be unique.");
  const lots=sourceLots.map((lot)=>({...lot,availableAt:canonicalTime(lot.availableAt,"Supply availability"),
    intakeAt:lot.intakeAt===null?null:canonicalTime(lot.intakeAt,"Receipt intake")}))
    .sort((left,right)=>compareText(left.availableAt,right.availableAt)||compareLots(left,right));
  const lines=sourceLines.map((line)=>({...line,orderTime:canonicalTime(line.orderTime,"Order time")})).sort(compareLines);
  const eligible=new LotHeap();
  let lotIndex=0;
  return lines.map((line)=>{
    while(lotIndex<lots.length&&lots[lotIndex]!.availableAt<=line.orderTime)eligible.push(lots[lotIndex++]!);
    let needed=line.quantity;
    let priceKnownQuantity=0;
    let marketTotalTenThousandths=0;
    let dateKnownQuantity=0;
    let weightedDayQuantity=0;
    const allocations:FifoAllocation[]=[];
    const excludedLots:FifoSupplyLot[]=[];
    while(needed>0&&eligible.size){
      const lot=eligible.peek()!;
      if(lot.excludedLineKeys?.includes(line.lineKey)){excludedLots.push(eligible.pop()!);continue;}
      const available=remaining.get(lot.supplyKey)??0;
      if(available<=0){eligible.pop();continue;}
      const quantity=Math.min(available,needed);
      remaining.set(lot.supplyKey,available-quantity);
      needed-=quantity;
      allocations.push({
        supplyKey:lot.supplyKey,receiptId:lot.receiptId,dispositionId:lot.dispositionId,
        quantityCorrectionId:lot.quantityCorrectionId??null,
        quantity,availableAt:lot.availableAt,
      });
      if(lot.marketValueTenThousandths!==null){
        priceKnownQuantity+=quantity;
        marketTotalTenThousandths+=quantity*lot.marketValueTenThousandths;
        if(!Number.isSafeInteger(marketTotalTenThousandths))throw new Error("FIFO market total exceeds safe arithmetic bounds.");
      }
      if(lot.intakeAt!==null){
        dateKnownQuantity+=quantity;
        weightedDayQuantity+=quantity*(Date.parse(line.orderTime)-Date.parse(lot.intakeAt))/millisecondsPerDay;
      }
      if(available===quantity)eligible.pop();
    }
    for(const lot of excludedLots)eligible.push(lot);
    const matchedQuantity=line.quantity-needed;
    return {
      lineKey:line.lineKey,allocations,requestedQuantity:line.quantity,matchedQuantity,
      unmatchedQuantity:needed,priceKnownQuantity,
      intakeMarketTotalCents:priceKnownQuantity===0?null:Math.round(marketTotalTenThousandths/100),
      dateKnownQuantity,
      weightedDaysHeld:dateKnownQuantity===0?null:weightedDayQuantity/dateKnownQuantity,
    };
  });
}
