import type { Page } from '@playwright/test';

// Test-only instrumentation. TaskDuration covers the renderer main thread;
// process CPU includes workers and utilities, as a percentage of one core.
// Neither measurement includes GPU utilization.
export async function monitorResources(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const browserCdp = await page.context().browser()!.newBrowserCDPSession();
  const processes = async () => (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;
  let processBaseline = await processes();
  const key = '__anagramResourceProbe';
  await page.evaluate((key) => {
    let longestTask = 0;
    let longestDelay = 0;
    let previous = performance.now();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longestTask = Math.max(longestTask, entry.duration);
    });
    observer.observe({ type: 'longtask' });
    const timer = setInterval(() => {
      const now = performance.now();
      longestDelay = Math.max(longestDelay, now - previous - 100);
      previous = now;
    }, 100);
    Object.assign(window, {
      [key]: {
        sample() {
          const result = { longestTask, longestDelay };
          longestTask = longestDelay = 0;
          return result;
        },
        stop() {
          clearInterval(timer);
          observer.disconnect();
        },
      },
    });
  }, key);
  const metrics = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
  };
  let baseline = await metrics();
  return {
    async sample(name: string) {
      const current = await metrics();
      const processCurrent = await processes();
      const stalls = await page.evaluate((key) => {
        const probe = (
          window as unknown as Record<
            string,
            {
              sample(): { longestTask: number; longestDelay: number };
            }
          >
        )[key];
        return probe.sample();
      }, key);
      const seconds = current.Timestamp - baseline.Timestamp;
      const processUsage = processCurrent.map((process) => {
        const previous = processBaseline.find((item) => item.id === process.id);
        return {
          type: process.type,
          cpuPercent: (100 * Math.max(0, process.cpuTime - (previous?.cpuTime ?? 0))) / seconds,
        };
      });
      const result = {
        name,
        seconds,
        browserCpuPercent: processUsage.reduce((total, process) => total + process.cpuPercent, 0),
        processes: processUsage,
        mainThreadSeconds: current.TaskDuration - baseline.TaskDuration,
        mainThreadCpuPercent: (100 * (current.TaskDuration - baseline.TaskDuration)) / seconds,
        ...stalls,
      };
      baseline = current;
      processBaseline = processCurrent;
      return result;
    },
    async stop() {
      await page.evaluate((key) => {
        const probes = window as unknown as Record<string, { stop(): void }>;
        probes[key].stop();
        delete probes[key];
      }, key);
      await cdp.detach();
      await browserCdp.detach();
    },
  };
}
