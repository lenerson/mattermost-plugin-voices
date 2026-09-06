package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
)

const (
	voiceInviteEvent     = "voice_invite"
	voiceInviteTTLMillis = 5 * 60 * 1000
	voiceInvitePostType  = "custom_webrtc_voice_invite"
	voiceInvitePropsKey  = "voice_invite"
	voiceInvitePending   = "pending"
	voiceInviteAccepted  = "accepted"
	voiceInviteDeclined  = "declined"
)

var (
	errVoiceInviteSelf              = errors.New("cannot invite yourself")
	errVoiceInviteRoomNotFound      = errors.New("voice room not found")
	errVoiceInviteSenderNotInRoom   = errors.New("inviter is not in that voice room")
	errVoiceInviteTargetUnavailable = errors.New("invited user is already in that voice room")
	errVoiceInvitePostInvalid       = errors.New("invalid voice invitation")
	errVoiceInviteExpired           = errors.New("voice invitation expired")
	errVoiceInviteAlreadyAnswered   = errors.New("voice invitation already answered")
)

type voiceInviteRecord struct {
	InviteID         string `json:"inviteId"`
	RoomID           string `json:"roomId"`
	RoomName         string `json:"roomName"`
	InviterID        string `json:"inviterId"`
	InviterUsername  string `json:"inviterUsername"`
	InviterFirstName string `json:"inviterFirstName"`
	InviterLastName  string `json:"inviterLastName"`
	TargetUserID     string `json:"targetUserId"`
	TargetUsername   string `json:"targetUsername"`
	ExpiresAt        int64  `json:"expiresAt"`
	Status           string `json:"status"`
}

func (invite voiceInviteRecord) asMap() map[string]interface{} {
	return map[string]interface{}{
		"inviteId":         invite.InviteID,
		"roomId":           invite.RoomID,
		"roomName":         invite.RoomName,
		"inviterId":        invite.InviterID,
		"inviterUsername":  invite.InviterUsername,
		"inviterFirstName": invite.InviterFirstName,
		"inviterLastName":  invite.InviterLastName,
		"targetUserId":     invite.TargetUserID,
		"targetUsername":   invite.TargetUsername,
		"expiresAt":        invite.ExpiresAt,
		"status":           invite.Status,
	}
}

func voiceInviteFromPost(post *model.Post) (voiceInviteRecord, error) {
	if post == nil || post.Type != voiceInvitePostType || post.Props == nil {
		return voiceInviteRecord{}, errVoiceInvitePostInvalid
	}
	raw, ok := post.Props[voiceInvitePropsKey]
	if !ok {
		return voiceInviteRecord{}, errVoiceInvitePostInvalid
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return voiceInviteRecord{}, errVoiceInvitePostInvalid
	}
	var invite voiceInviteRecord
	if err = json.Unmarshal(encoded, &invite); err != nil || invite.InviteID == "" || invite.TargetUserID == "" {
		return voiceInviteRecord{}, errVoiceInvitePostInvalid
	}
	return invite, nil
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

	inviter, appErr := p.API.GetUser(inviterID)
	if appErr != nil || inviter == nil || inviter.DeleteAt != 0 {
		http.Error(w, "inviting user not found", http.StatusNotFound)
		return
	}
	invite := voiceInviteRecord{
		InviteID:       model.NewId(),
		RoomID:         room.RoomID,
		RoomName:       room.Name,
		InviterID:      inviterID,
		TargetUserID:   targetUserID,
		TargetUsername: target.Username,
		ExpiresAt:      model.GetMillis() + voiceInviteTTLMillis,
		Status:         voiceInvitePending,
	}
	invite.InviterUsername = inviter.Username
	invite.InviterFirstName = inviter.FirstName
	invite.InviterLastName = inviter.LastName

	directChannel, appErr := p.API.GetDirectChannel(inviterID, targetUserID)
	if appErr != nil || directChannel == nil {
		http.Error(w, "could not create direct channel", http.StatusInternalServerError)
		return
	}
	message := fmt.Sprintf("**Voice channel invitation** — @%s, @%s invited you to join **%s**. This invitation expires in five minutes.", target.Username, invite.InviterUsername, room.Name)
	createdPost, appErr := p.API.CreatePost(&model.Post{
		UserId:    inviterID,
		ChannelId: directChannel.Id,
		Message:   message,
		Type:      voiceInvitePostType,
		Props: map[string]interface{}{
			voiceInvitePropsKey: invite.asMap(),
		},
	})
	if appErr != nil || createdPost == nil {
		http.Error(w, "could not create invitation message", http.StatusInternalServerError)
		return
	}

	payload := invite.asMap()
	payload["postId"] = createdPost.Id
	p.API.PublishWebSocketEvent(voiceInviteEvent, payload, &model.WebsocketBroadcast{UserId: targetUserID})
	w.WriteHeader(http.StatusNoContent)
}

func (p *Plugin) handleVoiceInviteResponse(w http.ResponseWriter, r *http.Request) {
	if !p.isUserAuthenticated(r) {
		http.Error(w, "not authenticated", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		PostID   string `json:"postId"`
		InviteID string `json:"inviteId"`
		Decision string `json:"decision"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if body.PostID == "" || body.InviteID == "" || (body.Decision != voiceInviteAccepted && body.Decision != voiceInviteDeclined) {
		http.Error(w, errVoiceInvitePostInvalid.Error(), http.StatusBadRequest)
		return
	}

	post, appErr := p.API.GetPost(body.PostID)
	if appErr != nil || post == nil {
		http.Error(w, errVoiceInvitePostInvalid.Error(), http.StatusNotFound)
		return
	}
	invite, err := voiceInviteFromPost(post)
	if err != nil || invite.InviteID != body.InviteID {
		http.Error(w, errVoiceInvitePostInvalid.Error(), http.StatusBadRequest)
		return
	}
	if invite.TargetUserID != r.Header.Get("Mattermost-User-Id") {
		http.Error(w, "only the invited user can answer", http.StatusForbidden)
		return
	}
	if invite.ExpiresAt <= model.GetMillis() {
		http.Error(w, errVoiceInviteExpired.Error(), http.StatusGone)
		return
	}
	if invite.Status != voiceInvitePending {
		if invite.Status == body.Decision {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, errVoiceInviteAlreadyAnswered.Error(), http.StatusConflict)
		return
	}

	invite.Status = body.Decision
	post.Props[voiceInvitePropsKey] = invite.asMap()
	if _, appErr = p.API.UpdatePost(post); appErr != nil {
		http.Error(w, "could not update invitation message", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
