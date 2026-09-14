package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func authReq(method, url string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, url, body)
	r.Header.Set("Mattermost-User-Id", "user-1")
	return r
}

// --- /v1/signal/publish ---------------------------------------------------

func TestSignalPublishRejectsNonPOST(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodGet, "/v1/signal/publish", nil))
	assert.Equal(t, http.StatusMethodNotAllowed, w.Result().StatusCode)
}

func TestSignalPublishRequiresAuth(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/signal/publish",
		strings.NewReader(`{"topic":"t","payload":{}}`))
	p.ServeHTTP(nil, w, r)
	assert.Equal(t, http.StatusForbidden, w.Result().StatusCode)
}

func TestSignalPublishRejectsRateLimitedUser(t *testing.T) {
	p := &Plugin{}
	for i := 0; i < maxSignalRequestsPerMinute; i++ {
		require.True(t, p.getSignalLimits().allowRequest("user-1"))
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodPost, "/v1/signal/publish", strings.NewReader(`{"topic":"t","payload":{}}`)))
	assert.Equal(t, http.StatusTooManyRequests, w.Result().StatusCode)
}

func TestSignalPublishRejectsMalformedJSON(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodPost, "/v1/signal/publish",
		strings.NewReader(`{not json`)))
	assert.Equal(t, http.StatusBadRequest, w.Result().StatusCode)
}

func TestSignalPublishRejectsLegacyTopic(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodPost, "/v1/signal/publish",
		strings.NewReader(`{"topic":"room-X","payload":{"hello":"world"}}`)))
	assert.Equal(t, http.StatusBadRequest, w.Result().StatusCode)
	assert.Contains(t, w.Body.String(), "invalid signal envelope")
}

func TestSignalPublishRejectsMissingAuthorizedEnvelope(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodPost, "/v1/signal/publish",
		strings.NewReader(`{"payload":{}}`)))
	assert.Equal(t, http.StatusBadRequest, w.Result().StatusCode)
}

func TestSignalPublishAuthorizedEnvelopeDerivesSenderFromRequest(t *testing.T) {
	p := &Plugin{}
	session, err := p.getSignalSessions().create("user-1", "call-1", []string{"user-2"})
	require.NoError(t, err)

	ch, unsub := p.getSignal().subscribe(signalSessionTopic(session.ID))
	defer unsub()

	w := httptest.NewRecorder()
	body := fmt.Sprintf(`{"version":1,"sessionId":%q,"callId":"call-1","type":"webrtc","payload":{"candidate":"x"}}`, session.ID)
	p.ServeHTTP(nil, w, authReq(http.MethodPost, "/v1/signal/publish", strings.NewReader(body)))
	require.Equal(t, http.StatusOK, w.Result().StatusCode)

	select {
	case msg := <-ch:
		var envelope signalEnvelope
		require.NoError(t, json.Unmarshal(msg, &envelope))
		assert.Equal(t, "user-1", envelope.SenderID)
		assert.Equal(t, session.ID, envelope.SessionID)
		assert.JSONEq(t, `{"candidate":"x"}`, string(envelope.Payload))
	case <-time.After(time.Second):
		t.Fatal("subscriber did not receive authorized envelope")
	}
}

func TestSignalPublishAuthorizedEnvelopeRejectsOutsider(t *testing.T) {
	p := &Plugin{}
	session, err := p.getSignalSessions().create("user-1", "call-1", []string{"user-2"})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	body := fmt.Sprintf(`{"version":1,"sessionId":%q,"callId":"call-1","type":"webrtc","payload":{}}`, session.ID)
	r := authReq(http.MethodPost, "/v1/signal/publish", strings.NewReader(body))
	r.Header.Set("Mattermost-User-Id", "outsider")
	p.ServeHTTP(nil, w, r)
	assert.Equal(t, http.StatusForbidden, w.Result().StatusCode)
}

func TestSignalPublishAuthorizedEnvelopeRejectsAnotherSessionCallID(t *testing.T) {
	p := &Plugin{}
	session, err := p.getSignalSessions().create("user-1", "call-1", []string{"user-2"})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	body := fmt.Sprintf(`{"version":1,"sessionId":%q,"callId":"other-call","type":"webrtc","payload":{}}`, session.ID)
	p.ServeHTTP(nil, w, authReq(http.MethodPost, "/v1/signal/publish", strings.NewReader(body)))
	assert.Equal(t, http.StatusForbidden, w.Result().StatusCode)
}

func TestSignalSessionCreateReturnsSessionForAuthenticatedCaller(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodPost, "/v1/signal/sessions",
		strings.NewReader(`{"callId":"call-1","participants":["user-2"]}`)))
	require.Equal(t, http.StatusOK, w.Result().StatusCode)

	var response struct {
		Version   int    `json:"version"`
		SessionID string `json:"sessionId"`
		CallID    string `json:"callId"`
	}
	require.NoError(t, json.NewDecoder(w.Result().Body).Decode(&response))
	assert.Equal(t, signalProtocolVersion, response.Version)
	assert.NotEmpty(t, response.SessionID)
	assert.Equal(t, "call-1", response.CallID)
	assert.NoError(t, p.getSignalSessions().authorize(response.SessionID, "call-1", "user-2"))
}

func TestSignalSessionCloseRequiresOwner(t *testing.T) {
	p := &Plugin{}
	session, err := p.getSignalSessions().create("user-1", "call-1", []string{"user-2"})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	r := authReq(http.MethodDelete, "/v1/signal/sessions/"+session.ID, nil)
	r.Header.Set("Mattermost-User-Id", "user-2")
	p.ServeHTTP(nil, w, r)
	assert.Equal(t, http.StatusForbidden, w.Result().StatusCode)

	w = httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodDelete, "/v1/signal/sessions/"+session.ID, nil))
	assert.Equal(t, http.StatusNoContent, w.Result().StatusCode)
	assert.ErrorIs(t, p.getSignalSessions().authorize(session.ID, "call-1", "user-1"), errSignalSessionDenied)
}

func TestSignalSessionCreateForVoiceRoomUsesActivePresence(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, heartbeat(p, "user-1", "room-1").Code)
	require.Equal(t, http.StatusOK, heartbeat(p, "user-2", "room-1").Code)

	w := voiceRoomsRequest(p, http.MethodPost, "/v1/signal/sessions", "user-1", map[string]interface{}{
		"callId": "voice-call", "roomId": "room-1", "participants": []string{"attacker"},
	})
	require.Equal(t, http.StatusOK, w.Code)
	var response struct {
		SessionID string `json:"sessionId"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	assert.NoError(t, p.getSignalSessions().authorize(response.SessionID, "voice-call", "user-2"))
	assert.ErrorIs(t, p.getSignalSessions().authorize(response.SessionID, "voice-call", "attacker"), errSignalSessionDenied)
}

func TestSignalSessionCreateForVoiceRoomRejectsAbsentUser(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, heartbeat(p, "present", "room-1").Code)

	w := voiceRoomsRequest(p, http.MethodPost, "/v1/signal/sessions", "outsider", map[string]string{"callId": "voice-call", "roomId": "room-1"})
	assert.Equal(t, http.StatusForbidden, w.Code)
}

func TestSignalInviteDeliversOnlyToAuthorizedTargetInbox(t *testing.T) {
	p := &Plugin{}
	session, err := p.getSignalSessions().create("user-1", "call-1", []string{"user-2"})
	require.NoError(t, err)

	ch, unsub := p.getSignal().subscribe(signalInboxTopic("user-2"))
	defer unsub()
	w := httptest.NewRecorder()
	body := fmt.Sprintf(`{"sessionId":%q,"callId":"call-1","targetId":"user-2","payload":{"audioOnly":true}}`, session.ID)
	p.ServeHTTP(nil, w, authReq(http.MethodPost, "/v1/signal/invite", strings.NewReader(body)))
	require.Equal(t, http.StatusOK, w.Result().StatusCode)

	select {
	case msg := <-ch:
		var envelope signalEnvelope
		require.NoError(t, json.Unmarshal(msg, &envelope))
		assert.Equal(t, "invite", envelope.Type)
		assert.Equal(t, "user-1", envelope.SenderID)
		assert.Equal(t, session.ID, envelope.SessionID)
	case <-time.After(time.Second):
		t.Fatal("target inbox did not receive signal invite")
	}
}

// --- /v1/signal/stream ----------------------------------------------------

func TestSignalStreamRejectsNonGET(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodPost, "/v1/signal/stream?topic=t", nil))
	assert.Equal(t, http.StatusMethodNotAllowed, w.Result().StatusCode)
}

func TestSignalStreamRequiresAuth(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/v1/signal/stream?topic=t", nil)
	p.ServeHTTP(nil, w, r)
	assert.Equal(t, http.StatusForbidden, w.Result().StatusCode)
}

func TestSignalStreamRequiresAuthorizedSource(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodGet, "/v1/signal/stream", nil))
	assert.Equal(t, http.StatusBadRequest, w.Result().StatusCode)
	assert.Contains(t, w.Body.String(), "signal session is required")
}

func TestSignalStreamRejectsLegacyTopic(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, authReq(http.MethodGet, "/v1/signal/stream?topic=room", nil))
	assert.Equal(t, http.StatusBadRequest, w.Result().StatusCode)
}

func TestSignalStreamRejectsUnauthorizedSession(t *testing.T) {
	p := &Plugin{}
	session, err := p.getSignalSessions().create("user-1", "call-1", []string{"user-2"})
	require.NoError(t, err)
	w := httptest.NewRecorder()
	r := authReq(http.MethodGet, "/v1/signal/stream?sessionId="+session.ID, nil)
	r.Header.Set("Mattermost-User-Id", "outsider")
	p.ServeHTTP(nil, w, r)
	assert.Equal(t, http.StatusForbidden, w.Result().StatusCode)
}

// flushRecorder is an http.ResponseWriter that also implements http.Flusher
// and is safe for concurrent access from the handler goroutine and the test
// goroutine. httptest.NewRecorder does not implement Flusher, so the SSE
// handler bails out with 500 unless we supply one ourselves.
type flushRecorder struct {
	*httptest.ResponseRecorder
	mu  sync.Mutex
	buf bytes.Buffer
}

func newFlushRecorder() *flushRecorder {
	return &flushRecorder{ResponseRecorder: httptest.NewRecorder()}
}

func (f *flushRecorder) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.buf.Write(p)
}

func (f *flushRecorder) Flush() {}

func (f *flushRecorder) body() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.buf.String()
}

func TestSignalStreamHonoursContextCancellation(t *testing.T) {
	// Goal: handler must return promptly when the client disconnects
	// (request context is cancelled), even with no signal traffic.
	p := &Plugin{}
	session, err := p.getSignalSessions().create("user-1", "call-1", []string{"user-2"})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	r := authReq(http.MethodGet, "/v1/signal/stream?sessionId="+session.ID, nil).WithContext(ctx)
	w := newFlushRecorder()

	done := make(chan struct{})
	go func() {
		p.ServeHTTP(nil, w, r)
		close(done)
	}()

	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return after context cancellation")
	}

	res := w.Result()
	assert.Equal(t, "text/event-stream", res.Header.Get("Content-Type"))
	assert.Equal(t, "no-cache", res.Header.Get("Cache-Control"))
	assert.Equal(t, "keep-alive", res.Header.Get("Connection"))
}

func TestSignalStreamWritesSSEFramesForPublishedPayloads(t *testing.T) {
	p := &Plugin{}
	session, err := p.getSignalSessions().create("user-1", "call-1", []string{"user-2"})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := authReq(http.MethodGet, "/v1/signal/stream?sessionId="+session.ID, nil).WithContext(ctx)
	w := newFlushRecorder()

	done := make(chan struct{})
	go func() {
		p.ServeHTTP(nil, w, r)
		close(done)
	}()

	// Wait for subscription to be registered. The handler subscribes after
	// writing headers; flush is called only on a successful write, so we
	// poll the broker's subscriber list instead.
	require.Eventually(t, func() bool {
		p.getSignal().mu.RLock()
		defer p.getSignal().mu.RUnlock()
		return len(p.getSignal().subs[signalSessionTopic(session.ID)]) == 1
	}, time.Second, 5*time.Millisecond, "subscriber never registered")

	p.getSignal().publish(signalSessionTopic(session.ID), []byte(`{"k":1}`))
	p.getSignal().publish(signalSessionTopic(session.ID), []byte(`{"k":2}`))

	// Wait for both writes to land in the recorder.
	require.Eventually(t, func() bool {
		return strings.Count(w.body(), "\n\n") >= 2
	}, time.Second, 5*time.Millisecond, "expected two SSE frames")

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return after context cancellation")
	}

	frames := readSSEFrames(t, w.body())
	require.Len(t, frames, 2)
	assert.JSONEq(t, `{"k":1}`, frames[0])
	assert.JSONEq(t, `{"k":2}`, frames[1])
}

// readSSEFrames extracts the `data:` payload from each `data: ...\n\n` block.
func readSSEFrames(t *testing.T, body string) []string {
	t.Helper()
	var frames []string
	scanner := bufio.NewScanner(strings.NewReader(body))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			frames = append(frames, strings.TrimPrefix(line, "data: "))
		}
	}
	require.NoError(t, scanner.Err())
	return frames
}

// --- Unknown routes -------------------------------------------------------

func TestServeHTTPUnknownPathReturns404(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, httptest.NewRequest(http.MethodGet, "/v1/does-not-exist", nil))
	assert.Equal(t, http.StatusNotFound, w.Result().StatusCode)
}
