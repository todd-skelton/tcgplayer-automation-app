import axios from "axios";

const axiosClient = axios.create({
  timeout: 5000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  },
});

// Throttle config
const REQUEST_DELAY_MS = 1500;
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
    const { data: response } = await axiosClient.post<TResonse>(url, data);
    return response;
  } finally {
    releaseSlot();
  }
}
