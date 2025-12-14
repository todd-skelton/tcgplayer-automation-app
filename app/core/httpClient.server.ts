import axios from "axios";
import type { HttpConfig } from "./config/httpConfig.server";
import { getHttpConfig } from "./config/httpConfig.server";

const axiosClient = axios.create({
  withCredentials: true,
  headers: {
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
  },
});

// Update headers with current config before each request
axiosClient.interceptors.request.use(async (config) => {
  const httpConfig = await getHttpConfig();
  config.headers["User-Agent"] = httpConfig.userAgent;
  httpConfig.tcgAuthCookie &&
    (config.headers[
      "Cookie"
    ] = `TCGAuthTicket_Production=${httpConfig.tcgAuthCookie};`);
  return config;
});

// Throttle config
let lastRequestTime = 0;
let rateLimitedUntil = 0;

async function throttle() {
  const httpConfig = await getHttpConfig();
  const now = Date.now();

  // Check if we're still in cooldown period
  if (rateLimitedUntil > now) {
    const waitTime = rateLimitedUntil - now;
    console.log(
      `[HTTP] Rate limited, waiting ${Math.ceil(waitTime / 1000)}s...`
    );
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  const wait = Math.max(0, lastRequestTime + httpConfig.requestDelayMs - now);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestTime = Date.now();
}

async function handleRateLimit() {
  const httpConfig = await getHttpConfig();
  rateLimitedUntil = Date.now() + httpConfig.rateLimitCooldownMs;
  console.log(
    `[HTTP] 403 detected, entering ${Math.ceil(
      httpConfig.rateLimitCooldownMs / 1000
    )}s cooldown period`
  );
}

// Concurrency config
let activeRequests = 0;
const requestQueue: (() => void)[] = [];

async function acquireSlot() {
  const httpConfig = await getHttpConfig();
  if (activeRequests < httpConfig.maxConcurrentRequests) {
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
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      handleRateLimit();
      throw error;
    }
    throw error;
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
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      handleRateLimit();
      throw error;
    }
    throw error;
  } finally {
    releaseSlot();
  }
}
