import { useEffect, useState } from "react";

/** Returns current Date.now(), refreshed every second. */
export function useTickEverySecond(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
