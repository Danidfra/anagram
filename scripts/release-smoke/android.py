#!/usr/bin/env python3
"""Exercise the release APK through Android accessibility, without debug WebView access.

Uses a new local key and reads public relay data only. Does not publish a profile,
relay list or message. At least one configured WSS relay must connect.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

OUTPUT = Path(sys.argv[1])
PACKAGE = 'com.nostr.anagram'


def adb(*args, timeout=20, check=True):
    result = subprocess.run(['adb', *args], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        # Never print command arguments: the generated test key is entered through adb.
        raise RuntimeError('adb operation failed')
    return result.stdout.strip()


def running():
    crash = adb('logcat', '-d', '-b', 'crash')
    if f'Process: {PACKAGE}' in crash or f'>>> {PACKAGE} <<<' in crash:
        raise RuntimeError('Release APK crashed')
    if not adb('shell', 'pidof', PACKAGE, check=False):
        raise RuntimeError('Release APK exited')


def tree():
    running()
    adb('shell', 'uiautomator', 'dump', '/sdcard/anagram-smoke.xml', check=False)
    xml = adb('exec-out', 'cat', '/sdcard/anagram-smoke.xml')
    OUTPUT.joinpath('ui.xml').write_text(xml)
    return ET.fromstring(xml)


def find(label, root):
    return next((node for node in root.iter('node') if label.casefold() in
                 (node.get('text', '').casefold(), node.get('content-desc', '').casefold()) and node.get('enabled') == 'true'), None)


def wait(label, seconds=45):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        node = find(label, tree())
        if node is not None:
            return node
        time.sleep(0.5)
    raise RuntimeError(f'Did not render enabled control: {label}')


def tap(node):
    left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds', '')))
    adb('shell', 'input', 'tap', str((left+right)//2), str((top+bottom)//2))


def click(label):
    tap(wait(label))


if not os.environ.get('ANDROID_SERIAL', '').startswith('emulator-') or adb('shell', 'getprop', 'ro.kernel.qemu') != '1':
    raise RuntimeError('Requires a disposable emulator')
click('Create Account')
click('Login Now')
wait('Connected', 60)
click('Next')
# A random identity has no existing profile. Empty profile + disabled relay-list
# publication completes onboarding without posting anything on public relays.
wait('Save and start using app')
root = tree()
checkboxes = [n for n in root.iter('node') if n.get('class') == 'android.widget.CheckBox' and n.get('text') == 'Use selected relays for my profile']
if len(checkboxes) != 1:
    raise RuntimeError('Expected the publish-relays checkbox; refusing to publish test data')
# WebView exposes this HTML checkbox as CheckBox but omits its checked state.
# The onboarding form starts with publishing enabled; toggle it off once.
tap(checkboxes[0])
click('Save and start using app')
end = time.monotonic() + 45
while time.monotonic() < end:
    root = tree()
    if find('settings', root) is not None:
        break
    skip = find('Not now', root)
    if skip is not None:
        tap(skip)
        break
    time.sleep(0.5)
wait('settings')
adb('shell', 'am', 'force-stop', PACKAGE)
adb('shell', 'am', 'start', '-W', '-n', f'{PACKAGE}/.MainActivity')
wait('settings')  # Native keystore identity restored after a real process restart.
click('settings')
click('Relays')
click('App Relays')
wait('Connected', 60)
running()
OUTPUT.joinpath('result.json').write_text(json.dumps({
    'passed': True,
    'checks': ['rendered-login', 'native-key-login', 'first-login-wss', 'cold-restart', 'wss-after-restart'],
    'relay_requirement': 'at least one default public WSS relay; read-only',
}, indent=2))
print('Release APK passed first-login WSS connectivity and native identity restoration.')
