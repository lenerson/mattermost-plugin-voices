package main

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type failingPresenceRepository struct {
	rooms []voiceRoom
	err   error
}

func (repo *failingPresenceRepository) readVoiceRooms() ([]voiceRoom, []byte, error) {
	return repo.rooms, nil, nil
}

func (repo *failingPresenceRepository) readVoicePresence() (voicePresence, []byte, error) {
	return voicePresence{}, nil, nil
}

func (repo *failingPresenceRepository) mutateVoiceRooms(mutate func([]voiceRoom) ([]voiceRoom, error)) ([]voiceRoom, error) {
	next, err := mutate(repo.rooms)
	if err == nil {
		repo.rooms = next
	}
	return next, err
}

func (repo *failingPresenceRepository) mutateVoicePresence(func(voicePresence) error) (voicePresence, error) {
	return nil, repo.err
}

func TestVoiceRoomServiceRestoresRoomWhenPresenceCleanupFails(t *testing.T) {
	storageErr := errors.New("presence storage unavailable")
	repo := &failingPresenceRepository{
		rooms: []voiceRoom{{RoomID: "room-1", CreatorID: "creator"}},
		err:   storageErr,
	}

	rooms, departed, err := (voiceRoomService{repo: repo}).deleteRoom("creator", "room-1", false)

	assert.ErrorIs(t, err, storageErr)
	assert.Nil(t, rooms)
	assert.Nil(t, departed)
	require.Len(t, repo.rooms, 1)
	assert.Equal(t, "room-1", repo.rooms[0].RoomID)
}
