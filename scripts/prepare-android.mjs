import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function prepareAndroid(root = new URL('../', import.meta.url)) {
  // Keep generated scaffolding on released Android tooling. The CLI template
  // currently requests API 37, which sdkmanager cannot install from stable.
  const gradle = new URL('src-tauri/gen/android/app/build.gradle.kts', root);
  writeFileSync(
    gradle,
    readFileSync(gradle, 'utf8')
      .replace(/compileSdk = \d+/, 'compileSdk = 36')
      .replace(/targetSdk = \d+/, 'targetSdk = 36')
      .replace(/optimization\s*\{\s*enable = true\s*\}/, 'isMinifyEnabled = true'),
  );
  const project = new URL('src-tauri/gen/android/build.gradle.kts', root);
  writeFileSync(
    project,
    readFileSync(project, 'utf8').replace(
      /com.android.tools.build:gradle:[^"\s]+/,
      'com.android.tools.build:gradle:8.11.1',
    ),
  );
  const buildSrc = new URL('src-tauri/gen/android/buildSrc/build.gradle.kts', root);
  writeFileSync(
    buildSrc,
    readFileSync(buildSrc, 'utf8').replace(
      /com.android.tools.build:gradle:[^"\s]+/,
      'com.android.tools.build:gradle:8.11.1',
    ),
  );
  writeFileSync(
    new URL('src-tauri/gen/android/app/secure-keys.pro', root),
    '-keep class com.nostr.anagram.SecureKeysPlugin { *; }\n-keep class com.nostr.anagram.PrivateKeyArgs { *; }\n',
  );
  const wrapper = new URL('src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties', root);
  writeFileSync(
    wrapper,
    readFileSync(wrapper, 'utf8').replace(/gradle-[\d.]+-bin.zip/, 'gradle-8.13-bin.zip'),
  );
  const properties = new URL('src-tauri/gen/android/gradle.properties', root);
  const gradleProperties = readFileSync(properties, 'utf8');
  if (!gradleProperties.includes('android.useAndroidX=true'))
    writeFileSync(properties, gradleProperties + '\nandroid.useAndroidX=true\n');
  const manifest = new URL('src-tauri/gen/android/app/src/main/AndroidManifest.xml', root);
  let xml = readFileSync(manifest, 'utf8');
  for (const name of ['RECORD_AUDIO', 'CAMERA', 'MODIFY_AUDIO_SETTINGS']) {
    if (!xml.includes(`android.permission.${name}`))
      xml = xml.replace(
        '<application',
        `<uses-permission android:name="android.permission.${name}" />\n    <application`,
      );
  }
  // Camera/microphone are optional: messaging must install on devices without them.
  for (const name of ['android.hardware.camera', 'android.hardware.microphone']) {
    if (!xml.includes(`android:name="${name}"`))
      xml = xml.replace(
        '<application',
        `<uses-feature android:name="${name}" android:required="false" />\n    <application`,
      );
  }
  if (!xml.includes('android:allowBackup='))
    xml = xml.replace('<application', '<application android:allowBackup="false"');
  writeFileSync(manifest, xml);
  const java = new URL('src-tauri/gen/android/app/src/main/java/com/nostr/anagram/', root);
  mkdirSync(java, { recursive: true });
  copyFileSync(
    new URL('src-tauri/mobile/android/SecureKeysPlugin.kt', root),
    new URL('SecureKeysPlugin.kt', java),
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) prepareAndroid();
