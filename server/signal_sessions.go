package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

const (
	signalProtocolVersion          = 1
	maxSignalCallIDLen             = 128
	maxSignalMessageTypeLen        = 64
	maxSignalSessionParticipants   = 16
	signalSessionIdentifierByteLen = 16
	signalSessionTTL               = 30 * time.Minute
	maxSignalSessionsPerOwner      = 5
)

var (
	errInvalidSignalSession = errors.New("invalid signal session")
	errSignalSessionDenied  = errors.New("signal session access denied")
	errSignalSessionLimit   = errors.New("signal session limit reached")
)

// signalEnvelope is the versioned wire contract used by authorized
// signalling. SenderID is assigned by the server and never trusted from a
// browser payload.
type signalEnvelope struct {
	Version   int             `json:"version"`
	SessionID string          `json:"sessionId"`
	CallID    string          `json:"callId"`
	Type      string          `json:"type"`
	SenderID  string          `json:"senderId"`
	Payload   json.RawMessage `json:"payload"`
}

// signalSession defines the authenticated users that may publish to and
// subscribe from one private signalling stream.
type signalSession struct {
	ID           string
	CallID       string
	OwnerID      string
	ExpiresAt    time.Time
	participants map[string]struct{}
	RoomID       string
}

type signalSessionStore struct {
	mu       sync.RWMutex
	sessions map[string]signalSession
	rooms    map[string]string
	now      func() time.Time
}

func newSignalSessionStore() *signalSessionStore {
	return &signalSessionStore{sessions: make(map[string]signalSession), rooms: make(map[string]string), now: time.Now}
}

func (s *signalSessionStore) forVoiceRoom(ownerID, roomID, callID string, participants []string) (signalSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneExpiredLocked(s.now())
	if id := s.rooms[roomID]; id != "" {
		session := s.sessions[id]
		session.participants = signalParticipants(participants)
		s.sessions[id] = session
		if _, allowed := session.participants[ownerID]; allowed {
			return session, nil
		}
		return signalSession{}, errSignalSessionDenied
	}

	participantsMap := signalParticipants(participants)
	if _, allowed := participantsMap[ownerID]; !allowed {
		return signalSession{}, errSignalSessionDenied
	}
	id, err := newSignalSessionID()
	if err != nil {
		return signalSession{}, err
	}
	session := signalSession{ID: id, CallID: callID, OwnerID: ownerID, RoomID: roomID, participants: participantsMap, ExpiresAt: s.now().Add(signalSessionTTL)}
	s.sessions[id] = session
	s.rooms[roomID] = id
	return session, nil
}

func (s *signalSessionStore) syncVoiceRoomParticipants(roomID string, participants []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.rooms[roomID]
	if id == "" {
		return
	}
	session, found := s.sessions[id]
	if !found {
		delete(s.rooms, roomID)
		return
	}
	if len(participants) == 0 {
		delete(s.sessions, id)
		delete(s.rooms, roomID)
		return
	}
	session.participants = signalParticipants(participants)
	s.sessions[id] = session
}

func signalParticipants(participants []string) map[string]struct{} {
	result := make(map[string]struct{}, len(participants))
	for _, participantID := range participants {
		result[participantID] = struct{}{}
	}
	return result
}

func newSignalSessionID() (string, error) {
	bytes := make([]byte, signalSessionIdentifierByteLen)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func (s *signalSessionStore) create(ownerID, callID string, participantIDs []string) (signalSession, error) {
	callID = strings.TrimSpace(callID)
	if ownerID == "" || callID == "" || len(callID) > maxSignalCallIDLen || len(participantIDs) > maxSignalSessionParticipants {
		return signalSession{}, errInvalidSignalSession
	}

	participants := map[string]struct{}{ownerID: {}}
	for _, participantID := range participantIDs {
		participantID = strings.TrimSpace(participantID)
		if participantID == "" {
			return signalSession{}, errInvalidSignalSession
		}
		participants[participantID] = struct{}{}
	}
	if len(participants) > maxSignalSessionParticipants {
		return signalSession{}, errInvalidSignalSession
	}

	id, err := newSignalSessionID()
	if err != nil {
		return signalSession{}, err
	}
	session := signalSession{
		ID:           id,
		CallID:       callID,
		OwnerID:      ownerID,
		participants: participants,
		ExpiresAt:    s.now().Add(signalSessionTTL),
	}

	s.mu.Lock()
	s.pruneExpiredLocked(s.now())
	ownersSessions := 0
	for _, existing := range s.sessions {
		if existing.OwnerID == ownerID {
			ownersSessions++
		}
	}
	if ownersSessions >= maxSignalSessionsPerOwner {
		s.mu.Unlock()
		return signalSession{}, errSignalSessionLimit
	}
	s.sessions[id] = session
	s.mu.Unlock()
	return session, nil
}

func (s *signalSessionStore) authorize(sessionID, callID, userID string) error {
	s.mu.Lock()
	s.pruneExpiredLocked(s.now())
	session, found := s.sessions[sessionID]
	s.mu.Unlock()
	if !found || (callID != "" && session.CallID != callID) {
		return errSignalSessionDenied
	}
	if _, allowed := session.participants[userID]; !allowed {
		return errSignalSessionDenied
	}
	return nil
}

func (s *signalSessionStore) close(sessionID, ownerID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, found := s.sessions[sessionID]
	if !found || session.OwnerID != ownerID {
		return errSignalSessionDenied
	}
	delete(s.sessions, sessionID)
	if session.RoomID != "" {
		delete(s.rooms, session.RoomID)
	}
	return nil
}

func (s *signalSessionStore) pruneExpiredLocked(now time.Time) {
	for id, session := range s.sessions {
		if !session.ExpiresAt.After(now) {
			delete(s.sessions, id)
			if session.RoomID != "" {
				delete(s.rooms, session.RoomID)
			}
		}
	}
}

func signalSessionTopic(sessionID string) string {
	return "session/" + sessionID
}

func signalInboxTopic(userID string) string {
	return "inbox/" + userID
}
