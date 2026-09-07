package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const maxSignalTopicLen = 1024

/*
 * How often to send an SSE comment frame on an otherwise silent stream.
 *
 * Most topics are idle by definition — call-<userId> carries nothing until
 * somebody actually rings — and a reverse proxy closes an idle connection
 * (nginx defaults to 60s), which kills the subscription without a sound.
 * A var rather than a const so tests need not wait for it.
 */
var signalStreamHeartbeat = 25 * time.Second

func (p *Plugin) handleSignalPublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !p.isUserAuthenticated(r) {
		http.Error(w, "not authenticated", http.StatusForbidden)
		return
	}

	var body struct {
		Topic   string          `json:"topic"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if body.Topic == "" || len(body.Topic) > maxSignalTopicLen {
		http.Error(w, "invalid topic", http.StatusBadRequest)
		return
	}
	if len(body.Payload) == 0 {
		body.Payload = []byte("{}")
	}

	p.getSignal().publish(body.Topic, body.Payload)
	w.WriteHeader(http.StatusOK)
}

func (p *Plugin) handleSignalStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !p.isUserAuthenticated(r) {
		http.Error(w, "not authenticated", http.StatusForbidden)
		return
	}
	topic := r.URL.Query().Get("topic")
	if topic == "" || len(topic) > maxSignalTopicLen {
		http.Error(w, "invalid topic", http.StatusBadRequest)
		return
	}

	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	// nginx buffers proxied responses by default, holding frames back until
	// the buffer fills, which is fatal for signalling that must arrive now.
	w.Header().Set("X-Accel-Buffering", "no")

	ch, unsub := p.getSignal().subscribe(topic)
	defer unsub()

	heartbeat := time.NewTicker(signalStreamHeartbeat)
	defer heartbeat.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			// A comment frame: EventSource ignores it, proxies see traffic.
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		case msg, ok := <-ch:
			if !ok {
				return
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", msg)
			fl.Flush()
		}
	}
}
