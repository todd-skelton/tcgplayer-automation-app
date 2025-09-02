/**
 * Formats processing time from milliseconds to a human-readable string
 * @param milliseconds - Time in milliseconds
 * @returns Formatted string like "2 hours 30 minutes 15 seconds"
 */
export const formatProcessingTime = (milliseconds: number): string => {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours} hour${hours !== 1 ? "s" : ""} ${minutes} minute${
      minutes !== 1 ? "s" : ""
    } ${seconds} second${seconds !== 1 ? "s" : ""}`;
  } else if (minutes > 0) {
    return `${minutes} minute${minutes !== 1 ? "s" : ""} ${seconds} second${
      seconds !== 1 ? "s" : ""
    }`;
  } else {
    return `${seconds} second${seconds !== 1 ? "s" : ""}`;
  }
};
