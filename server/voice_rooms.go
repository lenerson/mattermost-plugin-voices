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
	// voiceRoomsKey holds the whole directory as a single JSON value. Listing is
	// the hot path — every sidebar mount reads it — so one KVGet beats a KVList
	// followed by a KVGet per room.
	voiceRoomsKey = "voice_rooms"

	maxVoiceRooms       = 200
	maxVoiceRoomNameLen = 64
	maxVoiceRoomIDLen   = 128

	// Every writer races on that one key, so writes are compare-and-set + retry.
	voiceRoomsWriteAttempts = 5
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
	RoomID    string `json:"roomId"`
	Name      string `json:"name"`
	CreatorID string `json:"creatorId"`
	CreateAt  int64  `json:"createAt"`
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

// readVoiceRooms returns the directory plus the raw value it was decoded from,
// which the caller hands back to KVSetWithOptions as the compare-and-set base.
func (p *Plugin) readVoiceRooms() ([]voiceRoom, []byte, error) {
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

// mutateVoiceRooms applies mutate under compare-and-set, retrying when another
// writer won the race. mutate must return a new slice rather than edit its input.
func (p *Plugin) mutateVoiceRooms(mutate func([]voiceRoom) ([]voiceRoom, error)) ([]voiceRoom, error) {
	for attempt := 0; attempt < voiceRoomsWriteAttempts; attempt++ {
		current, raw, err := p.readVoiceRooms()
		if err != nil {
			return nil, err
		}

		next, mutErr := mutate(current)
		if mutErr != nil {
			return nil, mutErr
		}
		sortVoiceRooms(next)

		encoded, marshalErr := json.Marshal(next)
		if marshalErr != nil {
			return nil, marshalErr
		}

		ok, appErr := p.API.KVSetWithOptions(voiceRoomsKey, encoded, model.PluginKVSetOptions{
			Atomic:   true,
			OldValue: raw,
		})
		if appErr != nil {
			return nil, appErr
		}
		if ok {
			return next, nil
		}
	}
	return nil, errVoiceRoomsContended
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

func (p *Plugin) writeVoiceRoomsJSON(w http.ResponseWriter, rooms []voiceRoom) {
	presence, _, err := p.readVoicePresence()
	if err != nil {
		// Occupancy is not worth failing the whole listing over.
		p.API.LogWarn("Could not read voice presence", "error", err.Error())
		presence = voicePresence{}
	}
	prunePresence(presence, model.GetMillis())

	views := make([]voiceRoomView, 0, len(rooms))
	for _, room := range rooms {
		views = append(views, voiceRoomView{
			RoomID:       room.RoomID,
			Name:         room.Name,
			CreatorID:    room.CreatorID,
			CreateAt:     room.CreateAt,
			Participants: p.participantsFor(presence[room.RoomID]),
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
	rooms, _, err := p.readVoiceRooms()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	sortVoiceRooms(rooms)
	p.writeVoiceRoomsJSON(w, rooms)
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

	rooms, err := p.mutateVoiceRooms(func(current []voiceRoom) ([]voiceRoom, error) {
		for _, room := range current {
			if room.RoomID == roomID {
				// Re-announcing an existing room is a no-op, so a client that
				// retries cannot rename or steal someone else's room.
				return current, nil
			}
		}
		if len(current) >= maxVoiceRooms {
			return nil, errVoiceRoomsFull
		}
		next := make([]voiceRoom, 0, len(current)+1)
		next = append(next, current...)
		return append(next, voiceRoom{
			RoomID:    roomID,
			Name:      name,
			CreatorID: userID,
			CreateAt:  model.GetMillis(),
		}), nil
	})
	if err != nil {
		if errors.Is(err, errVoiceRoomsFull) {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	p.writeVoiceRoomsJSON(w, rooms)
}

func (p *Plugin) handleVoiceRoomDelete(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")

	roomID := strings.TrimSpace(r.URL.Query().Get("roomId"))
	if roomID == "" || len(roomID) > maxVoiceRoomIDLen {
		http.Error(w, "invalid roomId", http.StatusBadRequest)
		return
	}

	rooms, err := p.mutateVoiceRooms(func(current []voiceRoom) ([]voiceRoom, error) {
		next := make([]voiceRoom, 0, len(current))
		for _, room := range current {
			if room.RoomID != roomID {
				next = append(next, room)
				continue
			}
			if room.CreatorID != userID && !p.canManageAnyVoiceRoom(userID) {
				return nil, errVoiceRoomForbidden
			}
		}
		return next, nil
	})
	if err != nil {
		if errors.Is(err, errVoiceRoomForbidden) {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	p.writeVoiceRoomsJSON(w, rooms)
}
