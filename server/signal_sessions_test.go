package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSignalSessionStoreAuthorizesOnlyParticipantsAndMatchingCall(t *testing.T) {
	store := newSignalSessionStore()
	session, err := store.create("caller", "call-1", []string{"callee", "callee"})
	require.NoError(t, err)

	assert.NoError(t, store.authorize(session.ID, "call-1", "caller"))
	assert.NoError(t, store.authorize(session.ID, "call-1", "callee"))
	assert.ErrorIs(t, store.authorize(session.ID, "other-call", "callee"), errSignalSessionDenied)
	assert.ErrorIs(t, store.authorize(session.ID, "call-1", "outsider"), errSignalSessionDenied)
}

func TestSignalSessionStoreExpiresSessions(t *testing.T) {
	now := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	store := newSignalSessionStore()
	store.now = func() time.Time { return now }
	session, err := store.create("caller", "call-1", []string{"callee"})
	require.NoError(t, err)

	now = now.Add(signalSessionTTL)
	assert.ErrorIs(t, store.authorize(session.ID, "call-1", "caller"), errSignalSessionDenied)
}

func TestSignalSessionStoreCloseRequiresOwner(t *testing.T) {
	store := newSignalSessionStore()
	session, err := store.create("caller", "call-1", []string{"callee"})
	require.NoError(t, err)

	assert.ErrorIs(t, store.close(session.ID, "callee"), errSignalSessionDenied)
	assert.NoError(t, store.authorize(session.ID, "call-1", "caller"))
	assert.NoError(t, store.close(session.ID, "caller"))
	assert.ErrorIs(t, store.authorize(session.ID, "call-1", "caller"), errSignalSessionDenied)
}

func TestSignalSessionStoreLimitsSessionsPerOwner(t *testing.T) {
	store := newSignalSessionStore()
	for i := 0; i < maxSignalSessionsPerOwner; i++ {
		_, err := store.create("caller", "call-"+string(rune('a'+i)), nil)
		require.NoError(t, err)
	}
	_, err := store.create("caller", "one-too-many", nil)
	assert.ErrorIs(t, err, errSignalSessionLimit)
}

func TestSignalSessionStoreReusesVoiceRoomSession(t *testing.T) {
	store := newSignalSessionStore()
	first, err := store.forVoiceRoom("user-1", "room-1", "voice-call", []string{"user-1", "user-2"})
	require.NoError(t, err)
	second, err := store.forVoiceRoom("user-2", "room-1", "different-call", []string{"user-1", "user-2"})
	require.NoError(t, err)
	assert.Equal(t, first.ID, second.ID)

	_, err = store.forVoiceRoom("outsider", "room-1", "voice-call", []string{"user-1", "user-2"})
	assert.ErrorIs(t, err, errSignalSessionDenied)
	assert.NoError(t, store.close(first.ID, "user-1"))
	third, err := store.forVoiceRoom("user-1", "room-1", "new-call", []string{"user-1"})
	require.NoError(t, err)
	assert.NotEqual(t, first.ID, third.ID)
}

func TestSignalSessionStoreRejectsInvalidInputs(t *testing.T) {
	store := newSignalSessionStore()

	_, err := store.create("", "call-1", nil)
	assert.ErrorIs(t, err, errInvalidSignalSession)

	_, err = store.create("caller", "", nil)
	assert.ErrorIs(t, err, errInvalidSignalSession)

	_, err = store.create("caller", "call-1", []string{""})
	assert.ErrorIs(t, err, errInvalidSignalSession)
}
