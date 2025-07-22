import { useState, useEffect } from "react";

export function useLocalStorageState<T>(
  key: string,
  defaultValue: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  // Initialize state directly from localStorage or with a default value
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue; // Avoid SSR issues
    const storedValue = localStorage?.getItem(key);
    return storedValue ? JSON.parse(storedValue) : defaultValue;
  });

  // Watch for changes in state and save to localStorage
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);

  return [state, setState];
}
