# HTTP Configuration System

This document explains the HTTP configuration system that stores authentication credentials and request settings in local storage.

## Overview

The HTTP configuration system manages:

- **TCGPlayer Authentication Cookie**: Your TCGAuthTicket_Production cookie value
- **User Agent**: Browser user agent string for requests
- **Request Throttling**: Delay between consecutive requests
- **Rate Limit Handling**: Cooldown period after rate limit responses
- **Concurrency Control**: Maximum simultaneous requests

All settings are stored in browser local storage and persist across sessions.

## Files Created

### `app/core/config/httpConfig.ts`

Configuration hook and utilities:

- `useHttpConfig()` - React hook for managing HTTP settings
- `getHttpConfig()` - Get current config in non-React contexts
- `setHttpConfigInstance()` - Update config programmatically

### `app/routes/http-configuration.tsx`

Full HTTP configuration management page where users can:

- Set their TCGPlayer authentication cookie
- Customize user agent string
- Adjust request throttling parameters
- Configure rate limit handling
- Set maximum concurrent requests
- Reset all settings to defaults

## Configuration Structure

```typescript
interface HttpConfig {
  tcgAuthCookie: string; // TCGAuthTicket_Production cookie value
  userAgent: string; // Browser user agent
  requestDelayMs: number; // Delay between requests (default: 1500)
  rateLimitCooldownMs: number; // Cooldown after 403 (default: 60000)
  maxConcurrentRequests: number; // Max concurrent requests (default: 5)
}
```

## Usage

### React Components

```typescript
import { useHttpConfig } from "~/core/config/httpConfig";

function MyComponent() {
  const { config, updateAuthCookie } = useHttpConfig();

  // Check if cookie is configured
  if (!config.tcgAuthCookie) {
    return <Alert>Please configure authentication</Alert>;
  }

  // Update cookie
  updateAuthCookie("YOUR_COOKIE_VALUE");
}
```

### Non-React Contexts

```typescript
import { getHttpConfig } from "../config/httpConfig";

// Get current config
const config = getHttpConfig();
const cookie = config.tcgAuthCookie;
```

## How to Get Your Auth Cookie

1. Log in to [TCGPlayer.com](https://www.tcgplayer.com)
2. Open browser DevTools (F12)
3. Navigate to **Application** → **Storage** → **Cookies**
4. Find the cookie named `TCGAuthTicket_Production`
5. Copy its **value** (not the name)
6. Paste it into the HTTP Configuration page

## Updated Files

### `app/core/httpClient.ts`

Modified to:

- Import configuration from `httpConfig.ts`
- Use request interceptor to inject current auth cookie and user agent
- Read throttle and concurrency settings from config
- Dynamically adjust rate limiting based on config

### `app/routes/home.tsx`

Added:

- Warning banner when auth cookie is not configured
- Link to HTTP Configuration page in navigation

### `app/features/pricing/routes/configuration.tsx`

Added:

- Warning banner when auth cookie is missing
- Quick link to HTTP Configuration

### `app/routes.ts`

Added:

- `/http-configuration` route

## Security Considerations

1. **Local Storage**: The auth cookie is stored in browser local storage (not encrypted)
2. **Client-Side Only**: Config is only available in browser context
3. **Session Management**: Cookie should be updated when it expires
4. **No Server Storage**: Credentials are never sent to your server

## Benefits

1. **No Hardcoded Credentials**: Auth cookie is configurable, not in source code
2. **User-Specific**: Each user can use their own credentials
3. **Easy Updates**: Update cookie without modifying code
4. **Persistent**: Settings survive browser restarts
5. **Flexible**: Adjust throttling and concurrency as needed

## Accessing HTTP Configuration

Users can access HTTP settings via:

- Main navigation **🔐 HTTP Configuration** button on home page
- Warning banners on configuration pages (when cookie is missing)
- Direct URL: `/http-configuration`
