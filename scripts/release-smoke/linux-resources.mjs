import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Opt-in, Linux-only measurement of this disposable driver's process tree.
// Includes native/WebKit subprocesses, not unrelated desktop applications.
export async function checkLinuxIdleResources(execute, rootPid, caretFocused = true) {
  assert.equal(process.platform, 'linux');
  assert.ok(Number.isInteger(rootPid) && rootPid > 1);
  const hz = Number((await promisify(execFile)('getconf', ['CLK_TCK'])).stdout.trim());
  async function snapshot() {
    const records = (
      await Promise.all(
        (await readdir('/proc'))
          .filter((name) => /^\d+$/.test(name))
          .map(async (pid) => {
            try {
              const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
              const fields = stat
                .slice(stat.lastIndexOf(')') + 2)
                .trim()
                .split(/\s+/);
              return {
                pid: Number(pid),
                name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')),
                parent: Number(fields[1]),
                start: fields[19],
                ticks: Number(fields[11]) + Number(fields[12]),
              };
            } catch {
              return null;
            } // A subprocess can exit during enumeration.
          }),
      )
    ).filter(Boolean);
    const selected = new Set([rootPid]);
    let previous;
    do {
      previous = selected.size;
      for (const record of records) if (selected.has(record.parent)) selected.add(record.pid);
    } while (previous !== selected.size);
    return records.filter((record) => selected.has(record.pid));
  }
  if (!caretFocused) await execute('document.activeElement?.blur()');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  try {
    // Measure CPU without an in-page polling probe, then check responsiveness
    // separately so the measurement itself cannot inflate WebKit idle CPU.
    const before = await snapshot();
    assert.ok(before.length >= 3, 'driver, app and WebKit processes are included');
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 20000));
    const after = await snapshot();
    const seconds = (performance.now() - start) / 1000;
    let ticks = 0;
    const processes = [];
    for (const record of after) {
      const prior = before.find((item) => item.pid === record.pid && item.start === record.start);
      const used = record.ticks - (prior?.ticks ?? 0);
      ticks += used;
      processes.push({ name: record.name, cpuPercent: (100 * used) / hz / seconds });
    }
    await execute(`
      window.__resourceProbe = {delay: 0, ticks: 0, last: performance.now()};
      window.__resourceProbe.timer = setInterval(() => {
        const p = window.__resourceProbe, now = performance.now();
        p.delay = Math.max(p.delay, now - p.last - 100); p.last = now; p.ticks++;
      }, 100);
    `);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const timing = await execute(
      'return {delay: window.__resourceProbe.delay, ticks: window.__resourceProbe.ticks}',
    );
    const result = {
      caretFocused,
      seconds,
      processCount: after.length,
      cpuPercent: (100 * ticks) / hz / seconds,
      longestDelayMs: timing.delay,
      heartbeatTicks: timing.ticks,
      processes,
    };
    console.log('Packaged idle resources:', JSON.stringify(result));
    // Software-rendered WebKit repaints the blinking caret. Budget the complete
    // native process tree separately from the browser main-thread-only metric.
    assert.ok(result.cpuPercent < (caretFocused ? 10 : 5), 'native idle CPU stays within budget');
    assert.ok(timing.delay < 1000 && timing.ticks >= 15, 'native UI remains responsive');
    return result;
  } finally {
    await execute('clearInterval(window.__resourceProbe.timer); delete window.__resourceProbe');
  }
}
