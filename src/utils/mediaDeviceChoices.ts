/** The menu already provides System default. Keep distinct physical inputs and
 * communications routes, even when their labels or group IDs are identical. */
export function mediaDeviceChoices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const seen = new Set<string>();
  return devices.filter((device) => {
    if (!device.deviceId || device.deviceId === 'default') return false;
    const key = `${device.kind}:${device.deviceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
