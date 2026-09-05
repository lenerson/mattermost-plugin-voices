package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
)

const (
	// voicePresenceKey holds who is in which room, as one JSON value for the
	// same reason the directory is one value: reading it is the hot path.
	voicePresenceKey = "voice_presence"

	// How long a heartbeat counts for. Leaving a room clears the entry outright,
	// so this only has to cover a closed tab or a crashed browser — long enough
	// that one missed beat does not drop somebody off the list.
	voicePresenceTTLMillis = 45 * 1000

	maxVoicePresencePerRoom = 100
)

// voicePresence maps a room id to the users in it, each with the time their
// heartbeat stops counting.
type voicePresence map[string]map[string]int64

// participant is what a client needs to show a name without having the user's
// profile loaded, which someone who never opened that room usually does not.
type participant struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
}

func (p *Plugin) readVoicePresence() (voicePresence, []byte, error) {
	raw, appErr := p.API.KVGet(voicePresenceKey)
	if appErr != nil {
		return nil, nil, appErr
	}
	if len(raw) == 0 {
		return voicePresence{}, raw, nil
	}

	presence := voicePresence{}
	if err := json.Unmarshal(raw, &presence); err != nil {
		p.API.LogWarn("Discarding unreadable voice presence", "error", err.Error())
		return voicePresence{}, raw, nil
	}
	return presence, raw, nil
}

// prune drops expired heartbeats and rooms left empty by them, and reports
// whether anything changed so callers can skip a pointless write.
func prunePresence(presence voicePresence, now int64) bool {
	changed := false
	for roomID, users := range presence {
		for userID, expiresAt := range users {
			if expiresAt <= now {
				delete(users, userID)
				changed = true
			}
		}
		if len(users) == 0 {
			delete(presence, roomID)
			changed = true
		}
	}
	return changed
}

func (p *Plugin) mutateVoicePresence(mutate func(voicePresence) error) (voicePresence, error) {
	for attempt := 0; attempt < voiceRoomsWriteAttempts; attempt++ {
		current, raw, err := p.readVoicePresence()
		if err != nil {
			return nil, err
		}

		prunePresence(current, model.GetMillis())

		if mutErr := mutate(current); mutErr != nil {
			return nil, mutErr
		}

		encoded, marshalErr := json.Marshal(current)
		if marshalErr != nil {
			return nil, marshalErr
		}

		ok, appErr := p.API.KVSetWithOptions(voicePresenceKey, encoded, model.PluginKVSetOptions{
			Atomic:   true,
			OldValue: raw,
		})
		if appErr != nil {
			return nil, appErr
		}
		if ok {
			return current, nil
		}
	}
	return nil, errVoiceRoomsContended
}

// participantsFor turns the ids held for a room into named participants,
// skipping anyone the server can no longer resolve.
func (p *Plugin) participantsFor(users map[string]int64) []participant {
	ids := make([]string, 0, len(users))
	for userID := range users {
		ids = append(ids, userID)
	}
	sort.Strings(ids)

	out := make([]participant, 0, len(ids))
	for _, userID := range ids {
		entry := participant{ID: userID}
		if user, appErr := p.API.GetUser(userID); appErr == nil && user != nil {
			entry.Username = user.Username
			entry.FirstName = user.FirstName
			entry.LastName = user.LastName
		}
		out = append(out, entry)
	}
	return out
}

// handleVoicePresence records that the caller is in a room, or in none.
// A heartbeat is a POST with {roomId}; leaving is the same call with it empty.
func (p *Plugin) handleVoicePresence(w http.ResponseWriter, r *http.Request) {
	if !p.isUserAuthenticated(r) {
		http.Error(w, "not authenticated", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userID := r.Header.Get("Mattermost-User-Id")

	var body struct {
		RoomID string `json:"roomId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	roomID := strings.TrimSpace(body.RoomID)
	if len(roomID) > maxVoiceRoomIDLen {
		http.Error(w, "invalid roomId", http.StatusBadRequest)
		return
	}

	_, err := p.mutateVoicePresence(func(presence voicePresence) error {
		// One room at a time: a heartbeat for a new room is also a departure
		// from the previous one, which is what a reconnect or a second tab
		// would otherwise leave behind.
		for existing, users := range presence {
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
			presence[roomID] = map[string]int64{}
		}
		if _, already := presence[roomID][userID]; !already && len(presence[roomID]) >= maxVoicePresencePerRoom {
			return errVoiceRoomsFull
		}
		presence[roomID][userID] = model.GetMillis() + voicePresenceTTLMillis
		return nil
	})
	if err != nil {
		status := http.StatusInternalServerError
		if err == errVoiceRoomsFull {
			status = http.StatusConflict
		}
		http.Error(w, err.Error(), status)
		return
	}

	p.handleVoiceRoomsList(w)
}
