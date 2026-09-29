package main

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type failingDomainRepository struct {
	state voiceDomainState
	err   error
}

func (repo *failingDomainRepository) readVoiceDomain() (voiceDomainState, []byte, error) {
	return repo.state, nil, nil
}

func (repo *failingDomainRepository) mutateVoiceDomain(mutate func(*voiceDomainState) error) (voiceDomainState, error) {
	working := voiceDomainState{Rooms: append([]voiceRoom{}, repo.state.Rooms...), Presence: voicePresence{}}
	for roomID, users := range repo.state.Presence {
		working.Presence[roomID] = map[string]voicePresenceEntry{}
		for userID, entry := range users {
			working.Presence[roomID][userID] = entry
		}
	}
	if err := mutate(&working); err != nil {
		return voiceDomainState{}, err
	}
	return voiceDomainState{}, repo.err
}

func (repo *failingDomainRepository) mutateVoiceRooms(func([]voiceRoom) ([]voiceRoom, error)) ([]voiceRoom, error) {
	return nil, repo.err
}

func TestVoiceRoomServicePreservesAtomicStateWhenDeleteFails(t *testing.T) {
	storageErr := errors.New("domain storage unavailable")
	repo := &failingDomainRepository{
		state: voiceDomainState{
			Rooms:    []voiceRoom{{RoomID: "room-1", CreatorID: "creator"}},
			Presence: voicePresence{"room-1": {"talker": voicePresenceEntry{ExpiresAt: 9999999999999}}},
		},
		err: storageErr,
	}

	rooms, departed, err := (voiceRoomService{repo: repo}).deleteRoom("creator", "room-1", false)

	assert.ErrorIs(t, err, storageErr)
	assert.Nil(t, rooms)
	assert.Nil(t, departed)
	require.Len(t, repo.state.Rooms, 1)
	assert.Equal(t, "room-1", repo.state.Rooms[0].RoomID)
	assert.Contains(t, repo.state.Presence["room-1"], "talker")
}
