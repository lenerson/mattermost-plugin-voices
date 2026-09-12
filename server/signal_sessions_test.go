package main

import (
	"testing"

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

func TestSignalSessionStoreRejectsInvalidInputs(t *testing.T) {
	store := newSignalSessionStore()

	_, err := store.create("", "call-1", nil)
	assert.ErrorIs(t, err, errInvalidSignalSession)

	_, err = store.create("caller", "", nil)
	assert.ErrorIs(t, err, errInvalidSignalSession)

	_, err = store.create("caller", "call-1", []string{""})
	assert.ErrorIs(t, err, errInvalidSignalSession)
}
