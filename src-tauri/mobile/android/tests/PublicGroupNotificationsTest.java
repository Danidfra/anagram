package com.nostr.anagram;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class PublicGroupNotificationsTest {
    private static final String OWNER = "11".repeat(32);
    private static final String AUTHOR = "22".repeat(32);
    private static final String ADDRESS = "34550:" + OWNER + ":public";
    private static final long NOW = 2_000_000L;

    private NotificationConversation conversation(boolean enabled) {
        NotificationConversation value = new NotificationConversation(ADDRESS, null, "Public room", "", "PR", true, enabled);
        value.publicSince = NOW - 60;
        return value;
    }
    private JSONObject event() throws Exception {
        return new JSONObject().put("kind", 9).put("pubkey", AUTHOR).put("created_at", NOW)
            .put("content", "hello").put("tags", new JSONArray().put(new JSONArray().put("a").put(ADDRESS)));
    }
    @Test public void publicAddressesAndPreferencesRoundTripWithoutPrivateRecipient() throws Exception {
        NotificationConversation value = conversation(true);
        value.blockedAuthors.add(AUTHOR);
        JSONObject json = value.toJson().put("recipientPubkey", AUTHOR);
        NotificationConversation restored = NotificationConversation.fromJson(json);
        assertNotNull(restored);
        assertTrue(restored.isPublicGroup());
        assertNull(restored.recipientPubkey);
        assertEquals(value.publicSince, restored.publicSince);
        assertEquals(value.blockedAuthors, restored.blockedAuthors);
        assertTrue(restored.notificationsEnabled);
        assertEquals(ADDRESS, NotificationConversation.normalizeChatId(ADDRESS));
        assertEquals(OWNER, NotificationConversation.normalizeChatId(OWNER));
        assertNull(NotificationConversation.normalizeChatId(ADDRESS + "/bad"));
    }
    @Test public void publicNotificationsRequireOptInAndRejectOwnOrBlockedMessages() throws Exception {
        NotificationConversation value = conversation(true);
        assertTrue(RelayNotificationService.isEligiblePublicMessage(event(), value, OWNER, NOW));
        assertFalse(RelayNotificationService.isEligiblePublicMessage(event(), conversation(false), OWNER, NOW));
        assertFalse(RelayNotificationService.isEligiblePublicMessage(event().put("pubkey", OWNER), value, OWNER, NOW));
        value.blockedAuthors.add(AUTHOR);
        assertFalse(RelayNotificationService.isEligiblePublicMessage(event(), value, OWNER, NOW));
    }
    @Test public void rejectsEditsHistoryFutureMessagesAndAmbiguousRoomTags() throws Exception {
        NotificationConversation value = conversation(true);
        assertFalse(RelayNotificationService.isEligiblePublicMessage(event().put("created_at", NOW - 61), value, OWNER, NOW));
        assertFalse(RelayNotificationService.isEligiblePublicMessage(event().put("created_at", NOW + 301), value, OWNER, NOW));
        assertFalse(RelayNotificationService.isEligiblePublicMessage(event().put("kind", 1059), value, OWNER, NOW));
        assertFalse(RelayNotificationService.isEligiblePublicMessage(event().put("content", ""), value, OWNER, NOW));
        JSONObject edited = event();
        edited.getJSONArray("tags").put(new JSONArray().put("e").put("33".repeat(32)).put("").put("edit"));
        assertFalse(RelayNotificationService.isEligiblePublicMessage(edited, value, OWNER, NOW));
        JSONObject duplicate = event();
        duplicate.getJSONArray("tags").put(new JSONArray().put("a").put(ADDRESS));
        assertFalse(RelayNotificationService.isEligiblePublicMessage(duplicate, value, OWNER, NOW));
        JSONObject wrong = event().put("tags", new JSONArray().put(new JSONArray().put("a").put(ADDRESS + "-other")));
        assertFalse(RelayNotificationService.isEligiblePublicMessage(wrong, value, OWNER, NOW));
    }
    @Test public void publicSubscriptionIsBoundedAndSeparateFromPrivateRecipients() throws Exception {
        NotificationConversation direct = new NotificationConversation(AUTHOR, null, "Direct", "", "D", true, true);
        assertNull(RelayNotificationService.publicSubscription("public-test", java.util.List.of(direct, conversation(false)), NOW));
        JSONArray request = new JSONArray(RelayNotificationService.publicSubscription("public-test",
            java.util.List.of(direct, conversation(false), conversation(true)), NOW));
        assertEquals("REQ", request.getString(0));
        assertEquals("public-test", request.getString(1));
        assertEquals(3, request.length());
        JSONObject filter = request.getJSONObject(2);
        assertEquals(9, filter.getJSONArray("kinds").getInt(0));
        assertEquals(ADDRESS, filter.getJSONArray("#a").getString(0));
        assertEquals(1, filter.getJSONArray("#a").length());
        assertEquals(50, filter.getInt("limit"));
        assertEquals(NOW - 60, filter.getLong("since"));
        assertFalse(filter.has("#p"));
    }
}
