"""Launch the real simulator bundle; this does not certify calls or physical devices."""
import json
from pathlib import Path
import plistlib
import subprocess
import time

from ios_permissions import CAPTURE_DESCRIPTIONS


def simulator_app(root):
    matches = []
    for app in root.rglob('*.app'):
        info_path = app / 'Info.plist'
        if not info_path.is_file():
            continue
        with info_path.open('rb') as source:
            info = plistlib.load(source)
        if info.get('CFBundleIdentifier') == 'com.nostr.anagram':
            matches.append((app, info))
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one Anagram simulator application')
    app, info = matches[0]
    if 'iPhoneSimulator' not in info.get('CFBundleSupportedPlatforms', []):
        raise RuntimeError('The built application is not an iPhone simulator bundle')
    for key in CAPTURE_DESCRIPTIONS:
        if not isinstance(info.get(key), str) or not info[key].strip():
            raise RuntimeError(f'Missing capture permission description: {key}')
    return app


def choose_device(devices):
    for runtime in sorted(devices, reverse=True):
        if '.iOS-' not in runtime:
            continue
        for device in devices[runtime]:
            if device.get('isAvailable') and device['name'].startswith('iPhone'):
                return device
    raise RuntimeError('No available iPhone simulator; install an iOS runtime in Xcode')


def main():
    artifacts = Path('.artifacts/ios-simulator').resolve()
    artifacts.mkdir(parents=True, exist_ok=True)

    def simctl(*args):
        return subprocess.check_output(['xcrun', 'simctl', *args], text=True, timeout=180)

    device = None
    booted_here = False
    try:
        app = simulator_app(Path('src-tauri/gen/apple/build')).resolve()
        device = choose_device(json.loads(simctl('list', 'devices', 'available', '--json'))['devices'])
        udid = device['udid']
        if device['state'] != 'Booted':
            simctl('boot', udid)
            booted_here = True
        simctl('bootstatus', udid, '-b')
        simctl('install', udid, str(app))
        output = simctl('launch', '--terminate-running-process',
                        f'--stdout={artifacts / "stdout.log"}',
                        f'--stderr={artifacts / "stderr.log"}', udid, 'com.nostr.anagram')
        pid = int(output.strip().rsplit(':', 1)[1])
        time.sleep(15)
        simctl('io', udid, 'screenshot', str(artifacts / 'launch.png'))
        processes = simctl('spawn', udid, 'launchctl', 'list')
        if not any(line.split() and line.split()[0] == str(pid) for line in processes.splitlines()):
            raise RuntimeError('The iPhone app exited after launch; inspect simulator diagnostics')
        (artifacts / 'result.json').write_text(json.dumps({
            'passed': True, 'device': device['name'], 'pid': pid,
            'scope': 'Installed and stayed running for 15 seconds; screenshot needs visual review',
        }, indent=2) + '\n')
        print('iPhone simulator app installed and stayed running; launch screenshot captured.')
    except Exception as error:
        (artifacts / 'failure.json').write_text(json.dumps({'error': str(error)}, indent=2) + '\n')
        raise
    finally:
        if device and booted_here:
            subprocess.run(['xcrun', 'simctl', 'shutdown', device['udid']], timeout=60, check=False)


if __name__ == '__main__':
    main()
