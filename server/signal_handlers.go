package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	maxSignalTopicLen         = 1024
	maxSignalRequestBodyBytes = 64 * 1024
)

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

	r.Body = http.MaxBytesReader(w, r.Body, maxSignalRequestBodyBytes)
	var body struct {
		Topic     string          `json:"topic"`
		Version   int             `json:"version"`
		SessionID string          `json:"sessionId"`
		CallID    string          `json:"callId"`
		Type      string          `json:"type"`
		Payload   json.RawMessage `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if body.Version != 0 || body.SessionID != "" || body.CallID != "" || body.Type != "" {
		envelope := signalEnvelope{
			Version:   body.Version,
			SessionID: body.SessionID,
			CallID:    body.CallID,
			Type:      body.Type,
			SenderID:  r.Header.Get("Mattermost-User-Id"),
			Payload:   body.Payload,
		}
		if body.Topic != "" || !isValidSignalEnvelope(envelope) {
			http.Error(w, "invalid signal envelope", http.StatusBadRequest)
			return
		}
		if err := p.getSignalSessions().authorize(envelope.SessionID, envelope.CallID, envelope.SenderID); err != nil {
			http.Error(w, "signal session access denied", http.StatusForbidden)
			return
		}

		encoded, err := json.Marshal(envelope)
		if err != nil {
			http.Error(w, "could not encode signal envelope", http.StatusInternalServerError)
			return
		}
		p.getSignal().publish(signalSessionTopic(envelope.SessionID), encoded)
		w.WriteHeader(http.StatusOK)
		return
	}

	// Legacy topics remain available only while the webapp migrates to the
	// authorized envelope protocol. New code must use a signal session.
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
	sessionID := r.URL.Query().Get("sessionId")
	if r.URL.Query().Get("inbox") == "true" {
		if topic != "" || sessionID != "" {
			http.Error(w, "invalid signal inbox", http.StatusBadRequest)
			return
		}
		topic = signalInboxTopic(r.Header.Get("Mattermost-User-Id"))
	} else if sessionID != "" {
		if topic != "" || p.getSignalSessions().authorize(sessionID, "", r.Header.Get("Mattermost-User-Id")) != nil {
			http.Error(w, "signal session access denied", http.StatusForbidden)
			return
		}
		topic = signalSessionTopic(sessionID)
	} else if topic == "" || len(topic) > maxSignalTopicLen {
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

// handleSignalInvite delivers a session invitation through the target user's
// private inbox. Both sender and target must already belong to the session.
func (p *Plugin) handleSignalInvite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !p.isUserAuthenticated(r) {
		http.Error(w, "not authenticated", http.StatusForbidden)
		return
	}

	var body struct {
		SessionID string          `json:"sessionId"`
		CallID    string          `json:"callId"`
		TargetID  string          `json:"targetId"`
		Payload   json.RawMessage `json:"payload"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSignalRequestBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.TargetID) == "" || !json.Valid(body.Payload) {
		http.Error(w, "invalid signal invite", http.StatusBadRequest)
		return
	}
	senderID := r.Header.Get("Mattermost-User-Id")
	if p.getSignalSessions().authorize(body.SessionID, body.CallID, senderID) != nil || p.getSignalSessions().authorize(body.SessionID, body.CallID, body.TargetID) != nil {
		http.Error(w, "signal session access denied", http.StatusForbidden)
		return
	}

	encoded, err := json.Marshal(signalEnvelope{Version: signalProtocolVersion, SessionID: body.SessionID, CallID: body.CallID, Type: "invite", SenderID: senderID, Payload: body.Payload})
	if err != nil {
		http.Error(w, "could not encode signal invite", http.StatusInternalServerError)
		return
	}
	p.getSignal().publish(signalInboxTopic(body.TargetID), encoded)
	w.WriteHeader(http.StatusOK)
}

func (p *Plugin) handleSignalSessionCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !p.isUserAuthenticated(r) {
		http.Error(w, "not authenticated", http.StatusForbidden)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxSignalRequestBodyBytes)
	var body struct {
		CallID       string   `json:"callId"`
		Participants []string `json:"participants"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	session, err := p.getSignalSessions().create(r.Header.Get("Mattermost-User-Id"), body.CallID, body.Participants)
	if err != nil {
		status := http.StatusInternalServerError
		if err == errInvalidSignalSession {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Version   int    `json:"version"`
		SessionID string `json:"sessionId"`
		CallID    string `json:"callId"`
	}{
		Version:   signalProtocolVersion,
		SessionID: session.ID,
		CallID:    session.CallID,
	})
}

func isValidSignalEnvelope(envelope signalEnvelope) bool {
	return envelope.Version == signalProtocolVersion &&
		strings.TrimSpace(envelope.SessionID) != "" &&
		strings.TrimSpace(envelope.CallID) != "" && len(envelope.CallID) <= maxSignalCallIDLen &&
		strings.TrimSpace(envelope.Type) != "" && len(envelope.Type) <= maxSignalMessageTypeLen &&
		len(envelope.Payload) > 0 && json.Valid(envelope.Payload)
}
