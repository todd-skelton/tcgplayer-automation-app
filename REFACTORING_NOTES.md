# Pricer Component Refactoring

This document describes the refactoring of the TCGPlayer CSV Pricer component to improve maintainability, readability, and code organization.

## Changes Made

### 1. **Separation of Concerns**

- **Types**: Moved all TypeScript interfaces to `app/types/pricing.ts`
- **Constants**: Extracted magic numbers and configuration to `app/constants/pricing.ts`
- **Utilities**: Created reusable utility functions in `app/utils/csvProcessing.ts`
- **Services**: Separated API calls into `app/services/pricingService.ts`

### 2. **Custom Hook Extraction**

- **useCSVProcessor**: Moved all CSV processing logic into a custom hook (`app/hooks/useCSVProcessor.ts`)
  - Manages state (processing, progress, error, summary)
  - Handles CSV parsing and row processing
  - Provides clean interface to the component

### 3. **Component Decomposition**

Split the monolithic component into smaller, focused components:

- **UploadForm** (`app/components/UploadForm.tsx`): Handles file upload and form submission
- **ProgressIndicator** (`app/components/ProgressIndicator.tsx`): Displays processing progress
- **ProcessingSummaryComponent** (`app/components/ProcessingSummary.tsx`): Shows detailed processing results

### 4. **Improved Type Safety**

- Added proper TypeScript interfaces for all data structures
- Used `type-only` imports where appropriate to comply with `verbatimModuleSyntax`
- Better type definitions for API responses

### 5. **Constants and Configuration**

- `PRICING_CONSTANTS`: Central configuration for percentiles, thresholds, etc.
- `PERCENTILES`: Dynamic array generation for percentile calculations
- `FILE_CONFIG`: File handling configuration

## File Structure

```
app/
├── components/
│   ├── index.ts                    # Component exports
│   ├── UploadForm.tsx             # File upload form
│   ├── ProgressIndicator.tsx      # Processing progress display
│   └── ProcessingSummary.tsx      # Results summary display
├── hooks/
│   └── useCSVProcessor.ts         # CSV processing logic
├── services/
│   └── pricingService.ts          # API service calls
├── utils/
│   └── csvProcessing.ts           # CSV utility functions
├── types/
│   └── pricing.ts                 # TypeScript interfaces
├── constants/
│   └── pricing.ts                 # Application constants
└── routes/
    └── pricer.tsx                 # Main component (now clean and focused)
```

## Benefits

### **Maintainability**

- Clear separation of concerns makes it easier to modify specific functionality
- Smaller, focused files are easier to understand and test
- Reusable components and utilities reduce code duplication

### **Readability**

- Main component is now ~50 lines instead of 883 lines
- Clear file organization makes it easy to find relevant code
- Self-documenting structure with descriptive file names

### **Testability**

- Individual components can be tested in isolation
- Custom hook can be tested independently of UI components
- Utility functions are pure and easily testable

### **Reusability**

- Components can be reused in other parts of the application
- Utility functions and services can be shared across features
- Constants are centralized and easily adjustable

### **Type Safety**

- Better TypeScript support with proper type definitions
- Reduced runtime errors through compile-time checking
- Improved IDE support with better intellisense

## Usage

The refactored component maintains the same external API:

```tsx
import PricerRoute from "./routes/pricer";

// Usage remains the same
<PricerRoute />;
```

All existing functionality is preserved while providing a much cleaner and more maintainable codebase.
