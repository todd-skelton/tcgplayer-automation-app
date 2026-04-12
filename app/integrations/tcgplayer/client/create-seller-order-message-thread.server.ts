import { messagesApi } from "~/core/clients";

export interface CreateSellerOrderMessageThreadRequest {
  sellerKey: string;
  subjectId: string;
  messageBody: string;
  associationType: "SellerOrder";
  associationValue: string;
}

export async function createSellerOrderMessageThread(
  request: CreateSellerOrderMessageThreadRequest,
): Promise<void> {
  await messagesApi.post<void, CreateSellerOrderMessageThreadRequest>(
    "/messages/threads?api-version=1.0",
    request,
  );
}
