package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
)

const voiceInviteEvent = "voice_invite"

var (
	errVoiceInviteSelf              = errors.New("cannot invite yourself")
	errVoiceInviteRoomNotFound      = errors.New("voice room not found")
	errVoiceInviteSenderNotInRoom   = errors.New("inviter is not in that voice room")
	errVoiceInviteTargetUnavailable = errors.New("invited user is already in that voice room")
)

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

func (p *Plugin) handleVoiceInvite(w http.ResponseWriter, r *http.Request) {
	if !p.isUserAuthenticated(r) {
		http.Error(w, "not authenticated", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	inviterID := r.Header.Get("Mattermost-User-Id")
	var body struct {
		RoomID       string `json:"roomId"`
		TargetUserID string `json:"targetUserId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	roomID := strings.TrimSpace(body.RoomID)
	targetUserID := strings.TrimSpace(body.TargetUserID)
	if roomID == "" || len(roomID) > maxVoiceRoomIDLen || targetUserID == "" || len(targetUserID) > 128 {
		http.Error(w, "invalid roomId or targetUserId", http.StatusBadRequest)
		return
	}
	if inviterID == targetUserID {
		http.Error(w, errVoiceInviteSelf.Error(), http.StatusBadRequest)
		return
	}

	rooms, _, err := p.readVoiceRooms()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	room := voiceRoomWithID(rooms, roomID)
	if room == nil {
		http.Error(w, errVoiceInviteRoomNotFound.Error(), http.StatusNotFound)
		return
	}

	target, appErr := p.API.GetUser(targetUserID)
	if appErr != nil || target == nil || target.DeleteAt != 0 {
		http.Error(w, "invited user not found", http.StatusNotFound)
		return
	}

	_, err = p.mutateVoicePresence(func(presence voicePresence) error {
		if userVoiceRoom(presence, inviterID) != roomID {
			return errVoiceInviteSenderNotInRoom
		}
		if userVoiceRoom(presence, targetUserID) == roomID {
			return errVoiceInviteTargetUnavailable
		}
		return nil
	})
	if err != nil {
		status := http.StatusInternalServerError
		switch err {
		case errVoiceInviteSenderNotInRoom:
			status = http.StatusForbidden
		case errVoiceInviteTargetUnavailable:
			status = http.StatusConflict
		}
		http.Error(w, err.Error(), status)
		return
	}

	inviter, _ := p.API.GetUser(inviterID)
	payload := map[string]interface{}{
		"roomId":           room.RoomID,
		"roomName":         room.Name,
		"inviterId":        inviterID,
		"inviterUsername":  "",
		"inviterFirstName": "",
		"inviterLastName":  "",
	}
	if inviter != nil {
		payload["inviterUsername"] = inviter.Username
		payload["inviterFirstName"] = inviter.FirstName
		payload["inviterLastName"] = inviter.LastName
	}

	p.API.PublishWebSocketEvent(voiceInviteEvent, payload, &model.WebsocketBroadcast{UserId: targetUserID})
	w.WriteHeader(http.StatusNoContent)
}
