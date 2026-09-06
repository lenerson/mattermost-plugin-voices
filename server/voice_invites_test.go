package main

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func inviteToVoiceRoom(p *Plugin, inviterID, targetUserID, roomID string) int {
	return voiceRoomsRequest(p, http.MethodPost, "/v1/voice/invite", inviterID, map[string]string{
		"roomId":       roomID,
		"targetUserId": targetUserID,
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

func TestVoiceInviteRejectsUserAlreadyInAnyRoom(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-2", "Planning").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "inviter", "room-1").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "busy-user", "room-2").Code)

	assert.Equal(t, http.StatusConflict, inviteToVoiceRoom(p, "inviter", "busy-user", "room-1"))
}

func TestVoiceInviteIsPublishedOnlyToTarget(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "inviter", "room-1").Code)
	kv.webSocketEvents = nil
	kv.webSocketPayloads = nil
	kv.webSocketTargets = nil

	assert.Equal(t, http.StatusNoContent, inviteToVoiceRoom(p, "inviter", "guest", "room-1"))
	require.Equal(t, []string{voiceInviteEvent}, kv.webSocketEvents)
	require.Len(t, kv.webSocketPayloads, 1)
	assert.Equal(t, "room-1", kv.webSocketPayloads[0]["roomId"])
	assert.Equal(t, "Standup", kv.webSocketPayloads[0]["roomName"])
	assert.Equal(t, "inviter", kv.webSocketPayloads[0]["inviterId"])
	assert.Equal(t, []string{"guest"}, kv.webSocketTargets)
}
