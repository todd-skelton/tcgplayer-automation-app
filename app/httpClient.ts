import axios from "axios";

const axiosClient = axios.create({
  timeout: 5000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    Cookie:
      "TCGAuthTicket_Production=105C6C922FA5F34C21888359FA528C0B2A26C5231C7A4C0C93C118FCC24783B7860A4343216E3A8244EA0499BBFF5F1AF79E4D1F74B0F00D1AE4E3A753C473BE626FF940AF246768D9EA84A982CCA724DF51984CFB7B0FFAE8E8AB03F394B27371C20F59DF8933F0EDCAAB70B1A7456C65AC870C;",
  },
});

// Throttle config
const REQUEST_DELAY_MS = 1000;
let lastRequestTime = 0;

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, lastRequestTime + REQUEST_DELAY_MS - now);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestTime = Date.now();
}

// Concurrency config
const MAX_CONCURRENT_REQUESTS = 5;
let activeRequests = 0;
const requestQueue: (() => void)[] = [];

async function acquireSlot() {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
    return;
  }
  await new Promise<void>((resolve) => requestQueue.push(resolve));
  activeRequests++;
}

function releaseSlot() {
  activeRequests--;
  if (requestQueue.length > 0) {
    const next = requestQueue.shift();
    if (next) next();
  }
}

export async function get<TResponse, TParams = any>(
  url: string,
  params?: TParams
): Promise<TResponse> {
  await acquireSlot();
  try {
    await throttle();
    console.log(`[HTTP GET] ${url}`, params ? { params } : "");
    const { data } = await axiosClient.get<TResponse>(url, { params });
    return data;
  } finally {
    releaseSlot();
  }
}

export async function post<TResonse, TData = any>(
  url: string,
  data?: TData
): Promise<TResonse> {
  await acquireSlot();
  try {
    await throttle();
    console.log(`[HTTP POST] ${url}`, data ? { data } : "");
    const { data: response } = await axiosClient.post<TResonse>(url, data);
    return response;
  } finally {
    releaseSlot();
  }
}
