import { useState, useEffect } from "react";

export function useLocalStorageState<T>(
  key: string,
  defaultValue: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  // Initialize state with default value to prevent SSR mismatch
  const [state, setState] = useState<T>(defaultValue);
  const [isHydrated, setIsHydrated] = useState(false);

  // On client-side mount, read from localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedValue = localStorage?.getItem(key);
      if (storedValue) {
        try {
          setState(JSON.parse(storedValue));
        } catch (error) {
          console.warn(
            `Failed to parse localStorage value for key "${key}":`,
            error
          );
        }
      }
      setIsHydrated(true);
    }
  }, [key]);

  // Watch for changes in state and save to localStorage
  useEffect(() => {
    if (isHydrated && typeof window !== "undefined") {
      localStorage.setItem(key, JSON.stringify(state));
    }
  }, [key, state, isHydrated]);

  return [state, setState];
}
