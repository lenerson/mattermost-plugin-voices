package main

import (
	"encoding/json"
	"errors"
	"sort"

	"github.com/mattermost/mattermost/server/public/model"
)

const voiceDomainKey = "voice_domain_v1"

const voiceDomainVersion = 1

var errVoiceDomainCorrupt = errors.New("unreadable voice domain state")

// voiceDomainState puts room existence and presence in one CAS-protected value.
// The older two keys are read only to seed this value during upgrade.
type voiceDomainState struct {
	Version  int           `json:"version"`
	Rooms    []voiceRoom   `json:"rooms"`
	Presence voicePresence `json:"presence"`
}

func (p *Plugin) readVoiceDomain() (voiceDomainState, []byte, error) {
	for attempt := 0; attempt < voiceRoomsWriteAttempts; attempt++ {
		raw, appErr := p.API.KVGet(voiceDomainKey)
		if appErr != nil {
			return voiceDomainState{}, nil, appErr
		}
		if len(raw) != 0 {
			var state voiceDomainState
			if err := json.Unmarshal(raw, &state); err != nil {
				return voiceDomainState{}, nil, errors.Join(errVoiceDomainCorrupt, err)
			}
			if state.Version != voiceDomainVersion || state.Rooms == nil || state.Presence == nil {
				return voiceDomainState{}, nil, errVoiceDomainCorrupt
			}
			return state, raw, nil
		}

		rooms, _, err := p.readLegacyVoiceRooms()
		if err != nil {
			return voiceDomainState{}, nil, err
		}
		presence, _, err := p.readLegacyVoicePresence()
		if err != nil {
			return voiceDomainState{}, nil, err
		}
		normalizeLegacyPresence(rooms, presence)
		state := voiceDomainState{Version: voiceDomainVersion, Rooms: rooms, Presence: presence}
		encoded, err := json.Marshal(state)
		if err != nil {
			return voiceDomainState{}, nil, err
		}
		ok, appErr := p.API.KVSetWithOptions(voiceDomainKey, encoded, model.PluginKVSetOptions{Atomic: true, OldValue: raw})
		if appErr != nil {
			return voiceDomainState{}, nil, appErr
		}
		if ok {
			return state, encoded, nil
		}
	}
	return voiceDomainState{}, nil, errVoiceRoomsContended
}

// Earlier builds could persist an orphaned room or duplicate user entry. Keep
// only live entries belonging to existing rooms and the freshest per user.
func normalizeLegacyPresence(rooms []voiceRoom, presence voicePresence) {
	prunePresence(presence, model.GetMillis())
	knownRooms := make(map[string]bool, len(rooms))
	for _, room := range rooms {
		knownRooms[room.RoomID] = true
	}
	roomIDs := make([]string, 0, len(presence))
	for roomID := range presence {
		roomIDs = append(roomIDs, roomID)
	}
	sort.Strings(roomIDs)
	latest := map[string]voicePresenceEntry{}
	owner := map[string]string{}
	for _, roomID := range roomIDs {
		if !knownRooms[roomID] {
			delete(presence, roomID)
			continue
		}
		for userID, entry := range presence[roomID] {
			if current, exists := latest[userID]; !exists || entry.ExpiresAt > current.ExpiresAt {
				latest[userID] = entry
				owner[userID] = roomID
			}
		}
	}
	for _, roomID := range roomIDs {
		for userID := range presence[roomID] {
			if owner[userID] != roomID {
				delete(presence[roomID], userID)
			}
		}
		if len(presence[roomID]) == 0 {
			delete(presence, roomID)
		}
	}
}

func (p *Plugin) mutateVoiceDomain(mutate func(*voiceDomainState) error) (voiceDomainState, error) {
	for attempt := 0; attempt < voiceRoomsWriteAttempts; attempt++ {
		state, raw, err := p.readVoiceDomain()
		if err != nil {
			return voiceDomainState{}, err
		}
		prunePresence(state.Presence, model.GetMillis())
		if mutateErr := mutate(&state); mutateErr != nil {
			return voiceDomainState{}, mutateErr
		}
		sortVoiceRooms(state.Rooms)
		encoded, err := json.Marshal(state)
		if err != nil {
			return voiceDomainState{}, err
		}
		ok, appErr := p.API.KVSetWithOptions(voiceDomainKey, encoded, model.PluginKVSetOptions{Atomic: true, OldValue: raw})
		if appErr != nil {
			return voiceDomainState{}, appErr
		}
		if ok {
			return state, nil
		}
	}
	return voiceDomainState{}, errVoiceRoomsContended
}
