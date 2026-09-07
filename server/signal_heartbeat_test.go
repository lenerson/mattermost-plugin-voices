package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func withHeartbeatInterval(t *testing.T, d time.Duration) {
	t.Helper()
	previous := signalStreamHeartbeat
	signalStreamHeartbeat = d
	t.Cleanup(func() {
		signalStreamHeartbeat = previous
	})
}

// startStream runs the SSE handler for a topic and returns the recorder plus a
// stop function that cancels the request and waits for the handler to return.
func startStream(t *testing.T, plugin *Plugin, topic string) (*flushRecorder, func()) {
	t.Helper()

	w := newFlushRecorder()
	ctx, cancel := context.WithCancel(context.Background())

	r := httptest.NewRequest(http.MethodGet, "/v1/signal/stream?topic="+topic, nil).WithContext(ctx)
	r.Header.Set("Mattermost-User-Id", "user1")

	done := make(chan struct{})
	go func() {
		plugin.ServeHTTP(nil, w, r)
		close(done)
	}()

	return w, func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("handler did not return when the request context was cancelled")
		}
	}
}

// An idle topic is the normal case — call-<userId> carries nothing until
// somebody actually rings — and with no traffic a reverse proxy closes the
// connection, which killed the subscription for the rest of the session.
func TestSignalStreamSendsHeartbeatWhileIdle(t *testing.T) {
	withHeartbeatInterval(t, 10*time.Millisecond)

	plugin := &Plugin{}
	w, stop := startStream(t, plugin, "idle-topic")
	defer stop()

	require.Eventually(t, func() bool {
		return strings.Count(w.body(), ": ping") >= 2
	}, 2*time.Second, 10*time.Millisecond, "expected repeated heartbeats on an idle topic")

	assert.NotContains(t, w.body(), "data:", "an idle topic must not emit data frames")
	assert.Equal(t, "no", w.Header().Get("X-Accel-Buffering"))
}

// The heartbeat must not disturb real signalling.
func TestSignalStreamDeliversDataAlongsideHeartbeat(t *testing.T) {
	withHeartbeatInterval(t, 10*time.Millisecond)

	plugin := &Plugin{}
	w, stop := startStream(t, plugin, "busy-topic")
	defer stop()

	// Publish repeatedly: the subscription is registered on the handler
	// goroutine, and the broker drops messages that arrive before it exists.
	require.Eventually(t, func() bool {
		plugin.getSignal().publish("busy-topic", []byte(`{"hello":"world"}`))
		return strings.Contains(w.body(), `data: {"hello":"world"}`)
	}, 2*time.Second, 20*time.Millisecond)

	assert.Contains(t, w.body(), ": ping", "heartbeats continue while data flows")
}

// A heartbeat write failure means the client is gone; the handler must not spin.
func TestSignalStreamStopsWhenHeartbeatWriteFails(t *testing.T) {
	withHeartbeatInterval(t, 10*time.Millisecond)

	plugin := &Plugin{}
	w, stop := startStream(t, plugin, "cancelled-topic")

	require.Eventually(t, func() bool {
		return strings.Contains(w.body(), ": ping")
	}, 2*time.Second, 10*time.Millisecond)

	// stop() fails the test if the handler is still running after cancellation.
	stop()
}
