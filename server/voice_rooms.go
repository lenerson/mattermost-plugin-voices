package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
)

const (
	// voiceRoomsKey is the legacy room directory used only for migration.
	voiceRoomsKey = "voice_rooms"

	maxVoiceRooms       = 200
	maxVoiceRoomNameLen = 64
	maxVoiceRoomIDLen   = 128

	// Every writer races on the canonical domain key, so writes retry CAS.
	voiceRoomsWriteAttempts = 20
)

var (
	errVoiceRoomsFull      = errors.New("voice room limit reached")
	errVoiceRoomForbidden  = errors.New("not allowed to delete this voice room")
	errVoiceRoomsContended = errors.New("voice room directory changed concurrently")
)

// voiceRoom is one entry of the server-side voice channel directory. Rooms used
// to live only in each client's localStorage, gossiped over the signal broker,
// which meant a room was invisible to anyone not subscribed at the instant it
// was announced.
type voiceRoom struct {
	RoomID     string `json:"roomId"`
	Name       string `json:"name"`
	CreatorID  string `json:"creatorId"`
	CreateAt   int64  `json:"createAt"`
	Generation string `json:"generation,omitempty"`
}

func sortVoiceRooms(rooms []voiceRoom) {
	sort.SliceStable(rooms, func(i, j int) bool {
		li := strings.ToLower(rooms[i].Name)
		lj := strings.ToLower(rooms[j].Name)
		if li == lj {
			return rooms[i].RoomID < rooms[j].RoomID
		}
		return li < lj
	})
}

// readLegacyVoiceRooms decodes the directory written by earlier plugin builds.
func (p *Plugin) readLegacyVoiceRooms() ([]voiceRoom, []byte, error) {
	raw, appErr := p.API.KVGet(voiceRoomsKey)
	if appErr != nil {
		return nil, nil, appErr
	}
	if len(raw) == 0 {
		return []voiceRoom{}, raw, nil
	}

	var rooms []voiceRoom
	if err := json.Unmarshal(raw, &rooms); err != nil {
		// A corrupt value must not wedge the directory forever: report it and
		// let the next write replace it wholesale.
		p.API.LogWarn("Discarding unreadable voice room directory", "error", err.Error())
		return []voiceRoom{}, raw, nil
	}
	return rooms, raw, nil
}

func (p *Plugin) readVoiceRooms() ([]voiceRoom, []byte, error) {
	state, raw, err := p.readVoiceDomain()
	return state.Rooms, raw, err
}

// mutateVoiceRooms updates the canonical room and presence snapshot by CAS.
func (p *Plugin) mutateVoiceRooms(mutate func([]voiceRoom) ([]voiceRoom, error)) ([]voiceRoom, error) {
	state, err := p.mutateVoiceDomain(func(state *voiceDomainState) error {
		next, err := mutate(state.Rooms)
		if err == nil {
			state.Rooms = next
		}
		return err
	})
	return state.Rooms, err
}

func (p *Plugin) canManageAnyVoiceRoom(userID string) bool {
	return p.API.HasPermissionTo(userID, model.PermissionManageSystem)
}

// voiceRoomView is a room plus who is currently in it, so the panel can show
// occupancy for rooms the viewer has not joined.
type voiceRoomView struct {
	RoomID       string        `json:"roomId"`
	Name         string        `json:"name"`
	CreatorID    string        `json:"creatorId"`
	CreateAt     int64         `json:"createAt"`
	Participants []participant `json:"participants"`
}

func (p *Plugin) writeVoiceRoomsJSON(w http.ResponseWriter) {
	state, _, err := p.readVoiceDomain()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	prunePresence(state.Presence, model.GetMillis())

	views := make([]voiceRoomView, 0, len(state.Rooms))
	for _, room := range state.Rooms {
		views = append(views, voiceRoomView{
			RoomID:       room.RoomID,
			Name:         room.Name,
			CreatorID:    room.CreatorID,
			CreateAt:     room.CreateAt,
			Participants: p.participantsFor(state.Presence[room.RoomID]),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(struct {
		Rooms []voiceRoomView `json:"rooms"`
	}{Rooms: views}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (p *Plugin) handleVoiceRooms(w http.ResponseWriter, r *http.Request) {
	if !p.isUserAuthenticated(r) {
		http.Error(w, "not authenticated", http.StatusForbidden)
		return
	}

	switch r.Method {
	case http.MethodGet:
		p.handleVoiceRoomsList(w)
	case http.MethodPost:
		p.handleVoiceRoomCreate(w, r)
	case http.MethodDelete:
		p.handleVoiceRoomDelete(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (p *Plugin) handleVoiceRoomsList(w http.ResponseWriter) {
	p.writeVoiceRoomsJSON(w)
}

func (p *Plugin) handleVoiceRoomCreate(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")

	// Enforced here, not only by hiding the button: the endpoint is reachable
	// by any logged-in user, so a client-side check would restrict nothing.
	if !p.canManageAnyVoiceRoom(userID) {
		http.Error(w, "only a system administrator can create a voice channel", http.StatusForbidden)
		return
	}

	var body struct {
		RoomID string `json:"roomId"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	roomID := strings.TrimSpace(body.RoomID)
	name := strings.TrimSpace(body.Name)
	if roomID == "" || len(roomID) > maxVoiceRoomIDLen {
		http.Error(w, "invalid roomId", http.StatusBadRequest)
		return
	}
	if name == "" || len(name) > maxVoiceRoomNameLen {
		http.Error(w, "invalid name", http.StatusBadRequest)
		return
	}

	p.voiceDomainMu.Lock()
	_, err := (voiceRoomService{repo: p}).createRoom(userID, roomID, name)
	p.voiceDomainMu.Unlock()
	if err != nil {
		if errors.Is(err, errVoiceRoomsFull) {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	p.writeVoiceRoomsJSON(w)
}

func (p *Plugin) handleVoiceRoomDelete(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")

	roomID := strings.TrimSpace(r.URL.Query().Get("roomId"))
	if roomID == "" || len(roomID) > maxVoiceRoomIDLen {
		http.Error(w, "invalid roomId", http.StatusBadRequest)
		return
	}

	canManageAny := p.canManageAnyVoiceRoom(userID)
	p.voiceDomainMu.Lock()
	_, departed, err := (voiceRoomService{repo: p}).deleteRoom(userID, roomID, canManageAny)
	p.voiceDomainMu.Unlock()
	if err != nil {
		if errors.Is(err, errVoiceRoomForbidden) {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	for _, departedID := range departed {
		p.API.PublishWebSocketEvent(voicePresenceEvent, map[string]interface{}{
			"userId": departedID, "previousRoomId": roomID, "roomId": "", "audioOn": false,
		}, &model.WebsocketBroadcast{})
	}
	p.getSignalSessions().syncVoiceRoomParticipants(roomID, nil)

	p.writeVoiceRoomsJSON(w)
}
