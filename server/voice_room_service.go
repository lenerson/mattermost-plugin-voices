package main

import (
	"errors"

	"github.com/mattermost/mattermost/server/public/model"
)

var errVoiceRoomNotFound = errors.New("voice room not found")

// voiceRoomRepository keeps the existing KV representation behind the domain
// operation. Its compare-and-set mutations remain responsible for retries.
type voiceRoomRepository interface {
	readVoiceDomain() (voiceDomainState, []byte, error)
	mutateVoiceDomain(func(*voiceDomainState) error) (voiceDomainState, error)
	mutateVoiceRooms(func([]voiceRoom) ([]voiceRoom, error)) ([]voiceRoom, error)
}

type voicePresenceChange struct {
	PreviousRoomID      string
	PreviousAudioOn     bool
	HadPreviousPresence bool
}

// voiceRoomService owns the invariants shared by the room and presence APIs.
// The repository CAS serializes related room and presence changes across nodes.
type voiceRoomService struct {
	repo voiceRoomRepository
}

func voiceRoomWithID(rooms []voiceRoom, roomID string) *voiceRoom {
	for i := range rooms {
		if rooms[i].RoomID == roomID {
			return &rooms[i]
		}
	}
	return nil
}

func userVoiceRoom(presence voicePresence, userID string) string {
	for roomID, users := range presence {
		if _, ok := users[userID]; ok {
			return roomID
		}
	}
	return ""
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
	departed := []string{}
	state, err := s.repo.mutateVoiceDomain(func(state *voiceDomainState) error {
		departed = departed[:0]
		next := make([]voiceRoom, 0, len(state.Rooms))
		for _, room := range state.Rooms {
			if room.RoomID != roomID {
				next = append(next, room)
				continue
			}
			if room.CreatorID != userID && !canManageAny {
				return errVoiceRoomForbidden
			}
		}
		for id := range state.Presence[roomID] {
			departed = append(departed, id)
		}
		state.Rooms = next
		delete(state.Presence, roomID)
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return state.Rooms, departed, nil
}

func (s voiceRoomService) inviteRoom(inviterID, targetID, roomID string) (voiceRoom, error) {
	state, _, err := s.repo.readVoiceDomain()
	if err != nil {
		return voiceRoom{}, err
	}
	room := voiceRoomWithID(state.Rooms, roomID)
	if room == nil {
		return voiceRoom{}, errVoiceInviteRoomNotFound
	}
	prunePresence(state.Presence, model.GetMillis())
	if userVoiceRoom(state.Presence, inviterID) != roomID {
		return voiceRoom{}, errVoiceInviteSenderNotInRoom
	}
	if userVoiceRoom(state.Presence, targetID) == roomID {
		return voiceRoom{}, errVoiceInviteTargetUnavailable
	}
	return *room, nil
}

func (s voiceRoomService) validateInviteRoom(invite voiceInviteRecord) error {
	state, _, err := s.repo.readVoiceDomain()
	if err != nil {
		return err
	}
	room := voiceRoomWithID(state.Rooms, invite.RoomID)
	if room == nil || room.CreateAt != invite.RoomCreateAt || room.Generation != invite.RoomGeneration {
		return errVoiceInviteExpired
	}
	return nil
}

func (s voiceRoomService) validateInviteResponse(invite voiceInviteRecord) error {
	state, _, err := s.repo.readVoiceDomain()
	if err != nil {
		return err
	}
	room := voiceRoomWithID(state.Rooms, invite.RoomID)
	if room == nil || room.CreateAt != invite.RoomCreateAt || room.Generation != invite.RoomGeneration {
		return errVoiceInviteExpired
	}
	prunePresence(state.Presence, model.GetMillis())
	if userVoiceRoom(state.Presence, invite.InviterID) != invite.RoomID || userVoiceRoom(state.Presence, invite.TargetUserID) == invite.RoomID {
		return errVoiceInviteExpired
	}
	return nil
}

func (s voiceRoomService) setPresence(userID, roomID string, audioOn bool) (voicePresenceChange, error) {
	change := voicePresenceChange{}
	_, err := s.repo.mutateVoiceDomain(func(state *voiceDomainState) error {
		if roomID != "" && voiceRoomWithID(state.Rooms, roomID) == nil {
			return errVoiceRoomNotFound
		}
		presence := state.Presence
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
