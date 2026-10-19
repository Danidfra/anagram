import plistlib
from pathlib import Path
import tempfile
import unittest

from ios import choose_device, simulator_app, welcome_visible


class SimulatorSmokeTests(unittest.TestCase):
    def test_requires_rendered_welcome_and_login_controls(self):
        self.assertTrue(welcome_visible('Welcome to Anagram\nCreate Account\nLogin with Key'))
        self.assertTrue(welcome_visible('WELCOME TO ANAGRAM\nCreate\nAccount\nLogin with Remote Signer'))

    def test_rejects_blank_screen_or_incomplete_welcome(self):
        self.assertFalse(welcome_visible('19:25'))
        self.assertFalse(welcome_visible('Welcome to Anagram\nCreate Account'))
        self.assertFalse(welcome_visible('Login with Key\nCreate Account'))

    def test_selects_an_available_iphone_in_an_ios_runtime(self):
        phone = {'name': 'iPhone 17', 'isAvailable': True, 'udid': 'test', 'state': 'Shutdown'}
        self.assertEqual(choose_device({
            'com.apple.CoreSimulator.SimRuntime.tvOS-26-0': [phone],
            'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
                dict(phone, name='iPad'), dict(phone, isAvailable=False), phone,
            ],
        }), phone)
        with self.assertRaises(RuntimeError):
            choose_device({'com.apple.CoreSimulator.SimRuntime.tvOS-26-0': [phone]})

    def test_rejects_device_bundles_and_missing_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'Anagram.app'
            app.mkdir()
            info = {
                'CFBundleIdentifier': 'com.nostr.anagram',
                'CFBundleSupportedPlatforms': ['iPhoneSimulator'],
                'NSCameraUsageDescription': 'Camera for calls',
                'NSMicrophoneUsageDescription': 'Microphone for calls',
            }

            def write(value):
                (app / 'Info.plist').write_bytes(plistlib.dumps(value))

            write(info)
            self.assertEqual(simulator_app(root), app)
            write(dict(info, CFBundleSupportedPlatforms=['iPhoneOS']))
            with self.assertRaisesRegex(RuntimeError, 'not an iPhone simulator'):
                simulator_app(root)
            write(dict(info, NSMicrophoneUsageDescription=''))
            with self.assertRaisesRegex(RuntimeError, 'permission description'):
                simulator_app(root)


if __name__ == '__main__':
    unittest.main()
