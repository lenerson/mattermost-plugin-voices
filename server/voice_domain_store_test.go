package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func secondVoicePlugin(first *Plugin) *Plugin {
	other := &Plugin{}
	other.SetAPI(first.API)
	return other
}

func TestVoiceDomainMigratesLegacyRoomsAndPresenceOnce(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	legacyRooms, err := json.Marshal([]voiceRoom{{RoomID: "old-room", Name: "Old", CreatorID: testAdmin, CreateAt: 42}})
	require.NoError(t, err)
	legacyPresence, err := json.Marshal(voicePresence{"old-room": {"talker": {ExpiresAt: model.GetMillis() + voicePresenceTTLMillis, AudioOn: true}}})
	require.NoError(t, err)
	kv.values[voiceRoomsKey] = legacyRooms
	kv.values[voicePresenceKey] = legacyPresence

	state, _, err := p.readVoiceDomain()
	require.NoError(t, err)
	require.Len(t, state.Rooms, 1)
	assert.Equal(t, "old-room", state.Rooms[0].RoomID)
	assert.Contains(t, state.Presence["old-room"], "talker")
	assert.NotEmpty(t, kv.values[voiceDomainKey])

	// Once migrated, old writers cannot overwrite the canonical snapshot.
	kv.values[voiceRoomsKey] = []byte("[]")
	kv.values[voicePresenceKey] = []byte("{}")
	state, _, err = secondVoicePlugin(p).readVoiceDomain()
	require.NoError(t, err)
	assert.Len(t, state.Rooms, 1)
	assert.Contains(t, state.Presence["old-room"], "talker")
}

func TestVoiceDomainRejectsCorruptCanonicalStateWithoutOverwritingIt(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	kv.values[voiceDomainKey] = []byte(`{"version":1,"rooms":[]}`)

	_, _, err := p.readVoiceDomain()
	assert.ErrorIs(t, err, errVoiceDomainCorrupt)
	assert.Equal(t, http.StatusInternalServerError, createVoiceRoom(p, testAdmin, "new-room", "New").Code)
	assert.Equal(t, []byte(`{"version":1,"rooms":[]}`), kv.values[voiceDomainKey])
}

func TestVoiceDomainConcurrentLegacyImportUsesOneCanonicalValue(t *testing.T) {
	first, kv := newVoiceRoomsPlugin()
	second := secondVoicePlugin(first)
	legacyRooms, err := json.Marshal([]voiceRoom{{RoomID: "old-room", Name: "Old", CreatorID: testAdmin}})
	require.NoError(t, err)
	kv.values[voiceRoomsKey] = legacyRooms

	start := make(chan struct{})
	var workers sync.WaitGroup
	results := make(chan voiceDomainState, 2)
	errors := make(chan error, 2)
	for _, p := range []*Plugin{first, second} {
		workers.Add(1)
		go func(p *Plugin) {
			defer workers.Done()
			<-start
			state, _, readErr := p.readVoiceDomain()
			results <- state
			errors <- readErr
		}(p)
	}
	close(start)
	workers.Wait()
	close(results)
	close(errors)
	for readErr := range errors {
		require.NoError(t, readErr)
	}
	for state := range results {
		require.Len(t, state.Rooms, 1)
		assert.Equal(t, "old-room", state.Rooms[0].RoomID)
	}
	assert.NotEmpty(t, kv.values[voiceDomainKey])
}

func TestVoiceDomainLegacyImportRemovesOrphansAndDuplicateMembership(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	rooms, err := json.Marshal([]voiceRoom{{RoomID: "room-1"}, {RoomID: "room-2"}})
	require.NoError(t, err)
	now := model.GetMillis()
	presence, err := json.Marshal(voicePresence{
		"room-1":       {"talker": {ExpiresAt: now + 1000, AudioOn: true}},
		"room-2":       {"talker": {ExpiresAt: now + 2000, AudioOn: false}},
		"removed-room": {"ghost": {ExpiresAt: now + 3000, AudioOn: true}},
	})
	require.NoError(t, err)
	kv.values[voiceRoomsKey] = rooms
	kv.values[voicePresenceKey] = presence

	state, _, err := p.readVoiceDomain()
	require.NoError(t, err)
	assert.Empty(t, state.Presence["room-1"])
	assert.Empty(t, state.Presence["removed-room"])
	assert.Contains(t, state.Presence["room-2"], "talker")
}

func TestVoiceDomainCrossInstanceHeartbeatAndDeleteAreAtomic(t *testing.T) {
	first, _ := newVoiceRoomsPlugin()
	second := secondVoicePlugin(first)
	require.Equal(t, http.StatusOK, createVoiceRoom(first, testAdmin, "room-1", "Room").Code)
	require.Equal(t, http.StatusOK, heartbeat(second, "talker", "room-1").Code)

	start := make(chan struct{})
	var workers sync.WaitGroup
	results := make(chan int, 8)
	for i := 0; i < 8; i++ {
		workers.Add(1)
		p := first
		if i%2 == 0 {
			p = second
		}
		go func() {
			defer workers.Done()
			<-start
			results <- heartbeat(p, "talker", "room-1").Code
		}()
	}
	close(start)
	deleted := voiceRoomsRequest(second, http.MethodDelete, "/v1/voice/rooms?roomId=room-1", testAdmin, nil)
	workers.Wait()
	close(results)

	require.Equal(t, http.StatusOK, deleted.Code)
	for status := range results {
		assert.Contains(t, []int{http.StatusOK, http.StatusNotFound}, status)
	}
	state, _, err := first.readVoiceDomain()
	require.NoError(t, err)
	assert.Empty(t, state.Rooms)
	assert.Empty(t, state.Presence["room-1"])
	assert.Equal(t, http.StatusNotFound, heartbeat(first, "talker", "room-1").Code)
}

func TestVoiceDomainCrossInstancePresenceRemainsExclusive(t *testing.T) {
	first, _ := newVoiceRoomsPlugin()
	second := secondVoicePlugin(first)
	require.Equal(t, http.StatusOK, createVoiceRoom(first, testAdmin, "room-1", "One").Code)
	require.Equal(t, http.StatusOK, createVoiceRoom(first, testAdmin, "room-2", "Two").Code)

	var workers sync.WaitGroup
	statuses := make(chan int, 2)
	for _, pair := range []struct {
		p      *Plugin
		roomID string
	}{{first, "room-1"}, {second, "room-2"}} {
		workers.Add(1)
		go func(p *Plugin, roomID string) {
			defer workers.Done()
			statuses <- heartbeat(p, "talker", roomID).Code
		}(pair.p, pair.roomID)
	}
	workers.Wait()
	close(statuses)
	for status := range statuses {
		assert.Equal(t, http.StatusOK, status)
	}

	state, _, err := first.readVoiceDomain()
	require.NoError(t, err)
	count := 0
	for _, users := range state.Presence {
		if _, exists := users["talker"]; exists {
			count++
		}
	}
	assert.Equal(t, 1, count)
}
