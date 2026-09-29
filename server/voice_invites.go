package main

import (
	"encoding/json"
	"errors"
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
	errVoiceInviteWrongTarget       = errors.New("only the invited user can answer")
)

type voiceInviteRecord struct {
	InviteID         string `json:"inviteId"`
	RoomID           string `json:"roomId"`
	RoomName         string `json:"roomName"`
	RoomCreateAt     int64  `json:"roomCreateAt"`
	RoomGeneration   string `json:"roomGeneration"`
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
		"roomCreateAt":     invite.RoomCreateAt,
		"roomGeneration":   invite.RoomGeneration,
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
	p.voiceDomainMu.Lock()
	defer p.voiceDomainMu.Unlock()
	err := (voiceInviteService{rooms: voiceRoomService{repo: p}, gateway: p}).send(inviterID, targetUserID, roomID)
	if err != nil {
		http.Error(w, err.Error(), voiceInviteErrorStatus(err))
		return
	}
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

	p.voiceDomainMu.Lock()
	defer p.voiceDomainMu.Unlock()
	err := (voiceInviteService{rooms: voiceRoomService{repo: p}, gateway: p}).respond(
		r.Header.Get("Mattermost-User-Id"), body.PostID, body.InviteID, body.Decision,
	)
	if err != nil {
		http.Error(w, err.Error(), voiceInviteResponseErrorStatus(err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func voiceInviteErrorStatus(err error) int {
	switch {
	case errors.Is(err, errVoiceInviteSelf):
		return http.StatusBadRequest
	case errors.Is(err, errVoiceInviteRoomNotFound), errors.Is(err, errVoiceInviteUserNotFound), errors.Is(err, errVoiceInviteInviterNotFound):
		return http.StatusNotFound
	case errors.Is(err, errVoiceInviteSenderNotInRoom):
		return http.StatusForbidden
	case errors.Is(err, errVoiceInviteTargetUnavailable):
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}

func voiceInviteResponseErrorStatus(err error) int {
	switch {
	case errors.Is(err, errVoiceInvitePostNotFound):
		return http.StatusNotFound
	case errors.Is(err, errVoiceInvitePostInvalid):
		return http.StatusBadRequest
	case errors.Is(err, errVoiceInviteWrongTarget):
		return http.StatusForbidden
	case errors.Is(err, errVoiceInviteExpired):
		return http.StatusGone
	case errors.Is(err, errVoiceInviteAlreadyAnswered):
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}
