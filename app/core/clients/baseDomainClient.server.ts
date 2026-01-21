import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import {
  type DomainKey,
  type DomainRateLimitConfig,
  getDomainConfig,
  getHttpConfig,
} from "../config/httpConfig.server";

// Retry configuration
const MAX_RETRIES = 3;
const RETRYABLE_STATUS_CODES = new Set([403, 429, 502, 503, 504]);

// ============================================================================
// Rate Limiting & Throttling (per-domain instance)
// ============================================================================

class RequestThrottler {
  private lastRequestStartTime = 0;
  private rateLimitedUntil = 0;
  private readonly startQueue: Array<() => void> = [];
  private isProcessingQueue = false;

  constructor(private readonly domainName: string) {}

  /**
   * Ensures requests are staggered by requestDelayMs, but allows up to
   * maxConcurrentRequests to be in-flight simultaneously.
   */
  async waitToStart(config: DomainRateLimitConfig): Promise<void> {
    // Wait out any active rate limit cooldown first
    const now = Date.now();
    if (this.rateLimitedUntil > now) {
      const waitTime = this.rateLimitedUntil - now;
      console.log(
        `[HTTP:${this.domainName}] Rate limited, waiting ${Math.ceil(
          waitTime / 1000,
        )}s...`,
      );
      await this.delay(waitTime);
    }

    // Queue this request and process sequentially to ensure proper staggering
    await new Promise<void>((resolve) => {
      this.startQueue.push(resolve);
      this.processQueue(config);
    });
  }

  private async processQueue(config: DomainRateLimitConfig): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.startQueue.length > 0) {
      // Enforce minimum delay between request starts
      const timeSinceLastStart = Date.now() - this.lastRequestStartTime;
      const remainingDelay = config.requestDelayMs - timeSinceLastStart;
      if (remainingDelay > 0) {
        await this.delay(remainingDelay);
      }

      this.lastRequestStartTime = Date.now();
      const next = this.startQueue.shift();
      next?.();
    }

    this.isProcessingQueue = false;
  }

  async applyRateLimitCooldown(config: DomainRateLimitConfig): Promise<void> {
    this.rateLimitedUntil = Date.now() + config.rateLimitCooldownMs;
    console.log(
      `[HTTP:${this.domainName}] Rate limit detected, entering ${Math.ceil(
        config.rateLimitCooldownMs / 1000,
      )}s cooldown period`,
    );
    await this.delay(config.rateLimitCooldownMs);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Concurrency Control (per-domain instance)
// ============================================================================

class ConcurrencyLimiter {
  private activeRequests = 0;
  private readonly queue: Array<() => void> = [];

  async acquire(maxConcurrent: number): Promise<void> {
    if (this.activeRequests < maxConcurrent) {
      this.activeRequests++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.activeRequests++;
  }

  release(): void {
    this.activeRequests--;
    const next = this.queue.shift();
    next?.();
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function isRetryableError(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    RETRYABLE_STATUS_CODES.has(error.response?.status ?? 0)
  );
}

function isRateLimitError(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    (error.response?.status === 403 || error.response?.status === 429)
  );
}

function calculateBackoff(attempt: number, baseDelayMs: number): number {
  // Exponential backoff: baseDelay * 2^attempt with jitter
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return exponentialDelay + jitter;
}

// ============================================================================
// Domain HTTP Client
// ============================================================================

export class DomainHttpClient {
  private readonly axiosClient: AxiosInstance;
  private readonly throttler: RequestThrottler;
  private readonly limiter: ConcurrencyLimiter;

  constructor(
    private readonly domainKey: DomainKey,
    private readonly baseUrl: string,
  ) {
    this.throttler = new RequestThrottler(domainKey);
    this.limiter = new ConcurrencyLimiter();

    // Create axios instance with base configuration
    this.axiosClient = axios.create({
      baseURL: baseUrl,
      withCredentials: true,
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
      },
    });

    // Update headers with current config before each request
    this.axiosClient.interceptors.request.use(async (config) => {
      const httpConfig = await getHttpConfig();
      config.headers["User-Agent"] = httpConfig.userAgent;
      if (httpConfig.tcgAuthCookie) {
        config.headers[
          "Cookie"
        ] = `TCGAuthTicket_Production=${httpConfig.tcgAuthCookie};`;
      }
      return config;
    });
  }

  /**
   * Execute a GET request with rate limiting, concurrency control, and retry logic.
   */
  async get<TResponse, TParams = unknown>(
    path: string,
    params?: TParams,
  ): Promise<TResponse> {
    return this.executeWithRetry(
      "GET",
      path,
      () => this.axiosClient.get<TResponse>(path, { params }),
      params ? { params } : undefined,
    );
  }

  /**
   * Execute a POST request with rate limiting, concurrency control, and retry logic.
   */
  async post<TResponse, TData = unknown>(
    path: string,
    data?: TData,
  ): Promise<TResponse> {
    return this.executeWithRetry(
      "POST",
      path,
      () => this.axiosClient.post<TResponse>(path, data),
      data ? { data } : undefined,
    );
  }

  /**
   * Execute request with retry logic, rate limiting, and concurrency control.
   */
  private async executeWithRetry<T>(
    method: string,
    path: string,
    requestFn: () => Promise<AxiosResponse<T>>,
    logContext?: unknown,
  ): Promise<T> {
    const domainConfig = await getDomainConfig(this.domainKey);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.limiter.acquire(domainConfig.maxConcurrentRequests);

      try {
        await this.throttler.waitToStart(domainConfig);

        if (attempt === 0) {
          console.log(
            `[HTTP:${this.domainKey} ${method}] ${path}`,
            logContext ?? "",
          );
        } else {
          console.log(
            `[HTTP:${this.domainKey} ${method}] Retry ${attempt}/${MAX_RETRIES}: ${path}`,
          );
        }

        const response = await requestFn();
        return response.data;
      } catch (error) {
        const isLastAttempt = attempt === MAX_RETRIES;

        if (!isRetryableError(error) || isLastAttempt) {
          throw error;
        }

        // Apply rate limit cooldown for 403/429, or exponential backoff for other retryable errors
        if (isRateLimitError(error)) {
          await this.throttler.applyRateLimitCooldown(domainConfig);
        } else {
          const backoffMs = calculateBackoff(
            attempt,
            domainConfig.requestDelayMs,
          );
          console.log(
            `[HTTP:${this.domainKey}] Transient error, backing off ${Math.ceil(
              backoffMs / 1000,
            )}s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      } finally {
        this.limiter.release();
      }
    }

    // This should never be reached due to the throw in the loop, but TypeScript needs it
    throw new Error(
      `Request to ${this.domainKey} failed after ${MAX_RETRIES} retries`,
    );
  }
}
