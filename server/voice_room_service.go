package main

import (
	"errors"

	"github.com/mattermost/mattermost/server/public/model"
)

var errVoiceRoomNotFound = errors.New("voice room not found")

// voiceRoomRepository keeps the existing KV representation behind the domain
// operation. Its compare-and-set mutations remain responsible for retries.
type voiceRoomRepository interface {
	readVoiceRooms() ([]voiceRoom, []byte, error)
	mutateVoicePresence(func(voicePresence) error) (voicePresence, error)
}

type voicePresenceChange struct {
	PreviousRoomID      string
	PreviousAudioOn     bool
	HadPreviousPresence bool
}

// voiceRoomService owns the invariants shared by the room and presence APIs.
// The plugin lock serializes related operations within this plugin process.
type voiceRoomService struct {
	repo voiceRoomRepository
}

func (s voiceRoomService) setPresence(userID, roomID string, audioOn bool) (voicePresenceChange, error) {
	if roomID != "" {
		rooms, _, err := s.repo.readVoiceRooms()
		if err != nil {
			return voicePresenceChange{}, err
		}
		if voiceRoomWithID(rooms, roomID) == nil {
			return voicePresenceChange{}, errVoiceRoomNotFound
		}
	}

	change := voicePresenceChange{}
	_, err := s.repo.mutateVoicePresence(func(presence voicePresence) error {
		// A CAS retry must report the previous state from the successful read.
		change = voicePresenceChange{}
		for existing, users := range presence {
			if entry, ok := users[userID]; ok {
				change.PreviousRoomID = existing
				change.PreviousAudioOn = entry.AudioOn
				change.HadPreviousPresence = true
			}
			if existing != roomID {
				delete(users, userID)
			}
			if len(users) == 0 {
				delete(presence, existing)
			}
		}

		if roomID == "" {
			return nil
		}
		if presence[roomID] == nil {
			presence[roomID] = map[string]voicePresenceEntry{}
		}
		if _, already := presence[roomID][userID]; !already && len(presence[roomID]) >= maxVoicePresencePerRoom {
			return errVoiceRoomsFull
		}
		presence[roomID][userID] = voicePresenceEntry{
			ExpiresAt: model.GetMillis() + voicePresenceTTLMillis,
			AudioOn:   audioOn,
		}
		return nil
	})
	return change, err
}
