package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func decodeVoiceRoomViews(t *testing.T, w *httptest.ResponseRecorder) []voiceRoomView {
	t.Helper()
	var payload struct {
		Rooms []voiceRoomView `json:"rooms"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	return payload.Rooms
}

func heartbeat(p *Plugin, userID, roomID string) *httptest.ResponseRecorder {
	return voiceRoomsRequest(p, http.MethodPost, "/v1/voice/presence", userID, map[string]string{
		"roomId": roomID,
	})
}

func heartbeatWithAudio(p *Plugin, userID, roomID string, audioOn bool) *httptest.ResponseRecorder {
	return voiceRoomsRequest(p, http.MethodPost, "/v1/voice/presence", userID, map[string]interface{}{
		"roomId":  roomID,
		"audioOn": audioOn,
	})
}

func participantIDs(view voiceRoomView) []string {
	ids := make([]string, 0, len(view.Participants))
	for _, entry := range view.Participants {
		ids = append(ids, entry.ID)
	}
	return ids
}

func TestVoicePresenceRequiresAuthentication(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	w := voiceRoomsRequest(p, http.MethodPost, "/v1/voice/presence", "", map[string]string{"roomId": "r1"})

	assert.Equal(t, http.StatusForbidden, w.Code)
}

func TestVoicePresenceMethodNotAllowed(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	w := voiceRoomsRequest(p, http.MethodGet, "/v1/voice/presence", "user1", nil)

	assert.Equal(t, http.StatusMethodNotAllowed, w.Code)
}

// The point of the whole feature: occupancy is visible to somebody who is not
// in the room and never has been.
func TestVoicePresenceIsVisibleToAnOutsider(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "talker", "room-1").Code)

	rooms := decodeVoiceRoomViews(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil))
	require.Len(t, rooms, 1)
	assert.Equal(t, []string{"talker"}, participantIDs(rooms[0]))
}

// A viewer who never opened the room will not have those profiles locally, so
// the server resolves names rather than leaving the client with bare ids.
func TestVoicePresenceCarriesNames(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "talker", "room-1").Code)

	rooms := decodeVoiceRoomViews(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil))
	require.Len(t, rooms[0].Participants, 1)
	assert.Equal(t, "talker-handle", rooms[0].Participants[0].Username)
	assert.True(t, rooms[0].Participants[0].AudioOn, "older clients that omit audioOn default to enabled")
}

func TestVoicePresenceCarriesMicrophoneState(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, heartbeatWithAudio(p, "talker", "room-1", false).Code)

	rooms := decodeVoiceRoomViews(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil))
	require.Len(t, rooms[0].Participants, 1)
	assert.False(t, rooms[0].Participants[0].AudioOn)

	require.Equal(t, http.StatusOK, heartbeatWithAudio(p, "talker", "room-1", true).Code)
	rooms = decodeVoiceRoomViews(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil))
	assert.True(t, rooms[0].Participants[0].AudioOn)
}

func TestVoicePresenceListsEveryoneInTheRoom(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Standup").Code)

	for _, userID := range []string{"anna", "bruno", "carla"} {
		require.Equal(t, http.StatusOK, heartbeat(p, userID, "room-1").Code)
	}

	rooms := decodeVoiceRoomViews(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil))
	assert.Equal(t, []string{"anna", "bruno", "carla"}, participantIDs(rooms[0]))
}

func TestVoicePresenceLeavingClearsTheEntry(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Standup").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "talker", "room-1").Code)

	// An empty roomId is how leaving is reported.
	require.Equal(t, http.StatusOK, heartbeat(p, "talker", "").Code)

	rooms := decodeVoiceRoomViews(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil))
	assert.Empty(t, rooms[0].Participants)
}

// Moving rooms, reconnecting, or a second tab must not leave a ghost behind.
func TestVoicePresenceIsExclusivePerUser(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "One").Code)
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-2", "Two").Code)

	require.Equal(t, http.StatusOK, heartbeat(p, "talker", "room-1").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "talker", "room-2").Code)

	rooms := decodeVoiceRoomViews(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil))
	byID := map[string]voiceRoomView{}
	for _, room := range rooms {
		byID[room.RoomID] = room
	}

	assert.Empty(t, participantIDs(byID["room-1"]), "the room just left must be empty")
	assert.Equal(t, []string{"talker"}, participantIDs(byID["room-2"]))
}

// A browser that crashes never reports leaving, so entries have to expire.
func TestVoicePresenceExpires(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Standup").Code)

	stale := voicePresence{"room-1": {"ghost": {ExpiresAt: model.GetMillis() - 1, AudioOn: true}}}
	encoded, err := json.Marshal(stale)
	require.NoError(t, err)
	kv.values[voicePresenceKey] = encoded

	rooms := decodeVoiceRoomViews(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil))
	assert.Empty(t, rooms[0].Participants)
}

func TestVoicePresenceHeartbeatKeepsAnEntryAlive(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Standup").Code)

	aboutToExpire := voicePresence{"room-1": {"talker": {ExpiresAt: model.GetMillis() + 1, AudioOn: true}}}
	encoded, err := json.Marshal(aboutToExpire)
	require.NoError(t, err)
	kv.values[voicePresenceKey] = encoded

	require.Equal(t, http.StatusOK, heartbeat(p, "talker", "room-1").Code)

	var stored voicePresence
	require.NoError(t, json.Unmarshal(kv.values[voicePresenceKey], &stored))
	assert.Greater(t, stored["room-1"]["talker"].ExpiresAt, model.GetMillis()+(voicePresenceTTLMillis/2))
}

func TestVoicePresenceReadsLegacyExpiryValues(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	legacy := map[string]map[string]int64{
		"room-1": {"talker": model.GetMillis() + voicePresenceTTLMillis},
	}
	encoded, err := json.Marshal(legacy)
	require.NoError(t, err)
	kv.values[voicePresenceKey] = encoded

	presence, _, err := p.readVoicePresence()
	require.NoError(t, err)
	assert.True(t, presence["room-1"]["talker"].AudioOn)
}

func TestVoicePresenceRecoversFromCorruptValue(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Standup").Code)
	kv.values[voicePresenceKey] = []byte("{not json")

	list := voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil)
	require.Equal(t, http.StatusOK, list.Code)
	assert.Empty(t, decodeVoiceRoomViews(t, list)[0].Participants)

	require.Equal(t, http.StatusOK, heartbeat(p, "talker", "room-1").Code)
	rooms := decodeVoiceRoomViews(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "outsider", nil))
	assert.Equal(t, []string{"talker"}, participantIDs(rooms[0]))
}
