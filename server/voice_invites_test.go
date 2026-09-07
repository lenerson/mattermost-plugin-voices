package main

import (
	"net/http"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func inviteToVoiceRoom(p *Plugin, inviterID, targetUserID, roomID string) int {
	return voiceRoomsRequest(p, http.MethodPost, "/v1/voice/invite", inviterID, map[string]string{
		"roomId":       roomID,
		"targetUserId": targetUserID,
	}).Code
}

func respondToVoiceInvite(p *Plugin, userID, postID, inviteID, decision string) int {
	return voiceRoomsRequest(p, http.MethodPost, "/v1/voice/invite/response", userID, map[string]string{
		"postId":   postID,
		"inviteId": inviteID,
		"decision": decision,
	}).Code
}

func TestVoiceInviteRequiresAuthenticationAndPost(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	assert.Equal(t, http.StatusForbidden, inviteToVoiceRoom(p, "", "guest", "room-1"))
	assert.Equal(t, http.StatusMethodNotAllowed, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/invite", "inviter", nil).Code)
}

func TestVoiceInviteRequiresInviterInRequestedRoom(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-2", "Planning").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "inviter", "room-1").Code)

	assert.Equal(t, http.StatusForbidden, inviteToVoiceRoom(p, "inviter", "guest", "room-2"))
	assert.Equal(t, http.StatusNotFound, inviteToVoiceRoom(p, "inviter", "guest", "missing-room"))
	assert.Equal(t, http.StatusBadRequest, inviteToVoiceRoom(p, "inviter", "inviter", "room-1"))
}

func TestVoiceInviteRejectsUserAlreadyInTargetRoom(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "inviter", "room-1").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "busy-user", "room-1").Code)

	assert.Equal(t, http.StatusConflict, inviteToVoiceRoom(p, "inviter", "busy-user", "room-1"))
}

func TestVoiceInviteAllowsUserInDifferentRoom(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-2", "Planning").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "inviter", "room-1").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "busy-user", "room-2").Code)

	assert.Equal(t, http.StatusNoContent, inviteToVoiceRoom(p, "inviter", "busy-user", "room-1"))
}

func TestVoiceInviteIsPublishedOnlyToTarget(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "inviter", "room-1").Code)
	kv.webSocketEvents = nil
	kv.webSocketPayloads = nil
	kv.webSocketTargets = nil

	sentAtEarliest := model.GetMillis()
	assert.Equal(t, http.StatusNoContent, inviteToVoiceRoom(p, "inviter", "guest", "room-1"))
	sentAtLatest := model.GetMillis()
	require.Equal(t, []string{voiceInviteEvent}, kv.webSocketEvents)
	require.Len(t, kv.webSocketPayloads, 1)
	assert.Equal(t, "room-1", kv.webSocketPayloads[0]["roomId"])
	assert.Equal(t, "Standup", kv.webSocketPayloads[0]["roomName"])
	assert.Equal(t, "inviter", kv.webSocketPayloads[0]["inviterId"])
	expiresAt, ok := kv.webSocketPayloads[0]["expiresAt"].(int64)
	require.True(t, ok)
	assert.GreaterOrEqual(t, expiresAt, sentAtEarliest+voiceInviteTTLMillis)
	assert.LessOrEqual(t, expiresAt, sentAtLatest+voiceInviteTTLMillis)
	postID, ok := kv.webSocketPayloads[0]["postId"].(string)
	require.True(t, ok)
	post := kv.posts[postID]
	require.NotNil(t, post)
	assert.Equal(t, "inviter", post.UserId)
	assert.Equal(t, "dm-inviter-guest", post.ChannelId)
	assert.Equal(t, voiceInvitePostType, post.Type)
	assert.Contains(t, post.Message, "@guest-handle")
	assert.Contains(t, post.Message, "Standup")
	assert.Equal(t, []string{"guest"}, kv.webSocketTargets)
}

func TestVoiceInviteResponseUpdatesDirectMessage(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "inviter", "room-1").Code)
	require.Equal(t, http.StatusNoContent, inviteToVoiceRoom(p, "inviter", "guest", "room-1"))

	payload := kv.webSocketPayloads[len(kv.webSocketPayloads)-1]
	postID := payload["postId"].(string)
	inviteID := payload["inviteId"].(string)
	assert.Equal(t, http.StatusNoContent, respondToVoiceInvite(p, "guest", postID, inviteID, voiceInviteAccepted))

	updated, err := voiceInviteFromPost(kv.posts[postID])
	require.NoError(t, err)
	assert.Equal(t, voiceInviteAccepted, updated.Status)
	assert.Equal(t, http.StatusNoContent, respondToVoiceInvite(p, "guest", postID, inviteID, voiceInviteAccepted))
	assert.Equal(t, http.StatusConflict, respondToVoiceInvite(p, "guest", postID, inviteID, voiceInviteDeclined))
}

func TestVoiceInviteResponseRequiresTargetAndUnexpiredInvite(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "inviter", "room-1").Code)
	require.Equal(t, http.StatusNoContent, inviteToVoiceRoom(p, "inviter", "guest", "room-1"))

	payload := kv.webSocketPayloads[len(kv.webSocketPayloads)-1]
	postID := payload["postId"].(string)
	inviteID := payload["inviteId"].(string)
	assert.Equal(t, http.StatusForbidden, respondToVoiceInvite(p, "someone-else", postID, inviteID, voiceInviteDeclined))

	invite, err := voiceInviteFromPost(kv.posts[postID])
	require.NoError(t, err)
	invite.ExpiresAt = model.GetMillis() - 1
	kv.posts[postID].Props[voiceInvitePropsKey] = invite.asMap()
	assert.Equal(t, http.StatusGone, respondToVoiceInvite(p, "guest", postID, inviteID, voiceInviteDeclined))
}
