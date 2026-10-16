package com.nostr.anagram;

import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static org.junit.Assume.*;

@RunWith(AndroidJUnit4.class)
public final class CallAudioDeviceTest {
    @Test public void defaultsToReceiverWhenPresentAndRestoresRoutingAfterHangup() throws Exception {
        assumeTrue(Build.VERSION.SDK_INT >= 31);
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        AudioManager audio = instrumentation.getTargetContext().getSystemService(AudioManager.class);
        // Generic emulators/tablets may expose only a loudspeaker. Report that
        // case explicitly; passing there is not physical receiver validation.
        boolean receiver = audio.getAvailableCommunicationDevices().stream()
            .anyMatch(d -> d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
        int defaultOutput = receiver ? AudioDeviceInfo.TYPE_BUILTIN_EARPIECE : AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
        System.out.println("Call audio receiver available: " + receiver);
        final PhoneCallAudio[] routing = new PhoneCallAudio[1];
        int previousMode = audio.getMode();
        // This tests AudioManager directly. WebView rendering/IPC is validated separately.
        instrumentation.runOnMainSync(() -> routing[0] = new PhoneCallAudio(instrumentation.getTargetContext()));
        try {
                // WebView capture may already have requested communication mode
                // before the call acquires its native route. Hangup must release it.
                instrumentation.runOnMainSync(() -> audio.setMode(AudioManager.MODE_IN_COMMUNICATION));
                instrumentation.runOnMainSync(() -> routing[0].configure(true, false));
                waitForDevice(audio, defaultOutput);
                instrumentation.runOnMainSync(() -> routing[0].configure(true, true));
                waitForDevice(audio, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
                instrumentation.runOnMainSync(() -> routing[0].configure(true, false));
                waitForDevice(audio, defaultOutput);
                instrumentation.runOnMainSync(() -> routing[0].close());
                long deadline = System.currentTimeMillis() + 5000;
                while (audio.getMode() != previousMode && System.currentTimeMillis() < deadline) Thread.sleep(50);
                assertEquals(previousMode, audio.getMode());
                // A previous loudspeaker choice must not carry into the next call.
                instrumentation.runOnMainSync(() -> routing[0].configure(true, false));
                waitForDevice(audio, defaultOutput);
        } finally { instrumentation.runOnMainSync(() -> routing[0].close()); }
    }
    private void waitForDevice(AudioManager audio, int type) throws Exception {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            AudioDeviceInfo device = audio.getCommunicationDevice();
            if (device != null && device.getType() == type && audio.getMode() == AudioManager.MODE_IN_COMMUNICATION) return;
            Thread.sleep(50);
        }
        fail("Call output did not reach device type " + type);
    }
}
