const MAX_DAILY_WAKES = 20;

export const reserveWatchWake = (used: readonly string[], key: string) => {
  if (used.includes(key)) {
    return { allowed: true, used };
  }

  return used.length < MAX_DAILY_WAKES
    ? { allowed: true, used: [...used, key] }
    : { allowed: false, used };
};
