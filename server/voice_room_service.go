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
	readVoicePresence() (voicePresence, []byte, error)
	mutateVoiceRooms(func([]voiceRoom) ([]voiceRoom, error)) ([]voiceRoom, error)
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

func (s voiceRoomService) createRoom(userID, roomID, name string) ([]voiceRoom, error) {
	return s.repo.mutateVoiceRooms(func(current []voiceRoom) ([]voiceRoom, error) {
		for _, room := range current {
			if room.RoomID == roomID {
				return current, nil
			}
		}
		if len(current) >= maxVoiceRooms {
			return nil, errVoiceRoomsFull
		}
		next := append([]voiceRoom{}, current...)
		return append(next, voiceRoom{
			RoomID: roomID, Name: name, CreatorID: userID, CreateAt: model.GetMillis(), Generation: model.NewId(),
		}), nil
	})
}

func (s voiceRoomService) deleteRoom(userID, roomID string, canManageAny bool) ([]voiceRoom, []string, error) {
	var removed *voiceRoom
	rooms, err := s.repo.mutateVoiceRooms(func(current []voiceRoom) ([]voiceRoom, error) {
		removed = nil
		next := make([]voiceRoom, 0, len(current))
		for _, room := range current {
			if room.RoomID != roomID {
				next = append(next, room)
				continue
			}
			if room.CreatorID != userID && !canManageAny {
				return nil, errVoiceRoomForbidden
			}
			deleted := room
			removed = &deleted
		}
		return next, nil
	})
	if err != nil {
		return nil, nil, err
	}

	departed := []string{}
	_, err = s.repo.mutateVoicePresence(func(presence voicePresence) error {
		departed = departed[:0]
		for id := range presence[roomID] {
			departed = append(departed, id)
		}
		delete(presence, roomID)
		return nil
	})
	if err != nil && removed != nil {
		// Two KV keys cannot be committed together. Restore the directory if
		// presence cleanup fails so a retry can complete the deletion.
		_, rollbackErr := s.repo.mutateVoiceRooms(func(current []voiceRoom) ([]voiceRoom, error) {
			if voiceRoomWithID(current, roomID) != nil {
				return current, nil
			}
			return append(append([]voiceRoom{}, current...), *removed), nil
		})
		if rollbackErr != nil {
			return nil, nil, errors.Join(err, rollbackErr)
		}
	}
	if err != nil {
		return nil, nil, err
	}
	return rooms, departed, err
}

func (s voiceRoomService) inviteRoom(inviterID, targetID, roomID string) (voiceRoom, error) {
	rooms, _, err := s.repo.readVoiceRooms()
	if err != nil {
		return voiceRoom{}, err
	}
	room := voiceRoomWithID(rooms, roomID)
	if room == nil {
		return voiceRoom{}, errVoiceInviteRoomNotFound
	}
	presence, _, err := s.repo.readVoicePresence()
	if err != nil {
		return voiceRoom{}, err
	}
	prunePresence(presence, model.GetMillis())
	if userVoiceRoom(presence, inviterID) != roomID {
		return voiceRoom{}, errVoiceInviteSenderNotInRoom
	}
	if userVoiceRoom(presence, targetID) == roomID {
		return voiceRoom{}, errVoiceInviteTargetUnavailable
	}
	return *room, nil
}

func (s voiceRoomService) validateInviteResponse(invite voiceInviteRecord) error {
	rooms, _, err := s.repo.readVoiceRooms()
	if err != nil {
		return err
	}
	room := voiceRoomWithID(rooms, invite.RoomID)
	if room == nil || room.CreateAt != invite.RoomCreateAt || room.Generation != invite.RoomGeneration {
		return errVoiceInviteExpired
	}
	presence, _, err := s.repo.readVoicePresence()
	if err != nil {
		return err
	}
	prunePresence(presence, model.GetMillis())
	if userVoiceRoom(presence, invite.InviterID) != invite.RoomID || userVoiceRoom(presence, invite.TargetUserID) == invite.RoomID {
		return errVoiceInviteExpired
	}
	return nil
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
