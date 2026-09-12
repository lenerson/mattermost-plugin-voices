package main

import (
	"sync"
)

const signalSubscriberBufferSize = 64

// signalBroker fans out JSON payloads to SSE subscribers per topic (hub app + "/" + channel).
type signalBroker struct {
	mu   sync.RWMutex
	subs map[string][]*signalSubscriber
}

// signalSubscriber owns its channel lifecycle. Its lock serializes a publish
// attempt with unsubscribe, so no goroutine can send after the channel closes.
type signalSubscriber struct {
	mu     sync.Mutex
	ch     chan []byte
	closed bool
}

func newSignalSubscriber() *signalSubscriber {
	return &signalSubscriber{
		ch: make(chan []byte, signalSubscriberBufferSize),
	}
}

func (s *signalSubscriber) deliver(payload []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return
	}

	copyOfPayload := make([]byte, len(payload))
	copy(copyOfPayload, payload)
	select {
	case s.ch <- copyOfPayload:
	default:
		// Slow SSE clients must not block signaling for other subscribers.
	}
}

func (s *signalSubscriber) close() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return
	}

	s.closed = true
	close(s.ch)
}

func newSignalBroker() *signalBroker {
	return &signalBroker{
		subs: make(map[string][]*signalSubscriber),
	}
}

func (b *signalBroker) subscribe(topic string) (<-chan []byte, func()) {
	subscriber := newSignalSubscriber()
	b.mu.Lock()
	b.subs[topic] = append(b.subs[topic], subscriber)
	b.mu.Unlock()

	var unsubscribeOnce sync.Once
	return subscriber.ch, func() {
		unsubscribeOnce.Do(func() {
			b.mu.Lock()
			arr := b.subs[topic]
			for i, candidate := range arr {
				if candidate == subscriber {
					b.subs[topic] = append(arr[:i], arr[i+1:]...)
					if len(b.subs[topic]) == 0 {
						delete(b.subs, topic)
					}
					break
				}
			}
			b.mu.Unlock()
			subscriber.close()
		})
	}
}

func (b *signalBroker) publish(topic string, payload []byte) {
	b.mu.RLock()
	slist := make([]*signalSubscriber, len(b.subs[topic]))
	copy(slist, b.subs[topic])
	b.mu.RUnlock()
	for _, subscriber := range slist {
		subscriber.deliver(payload)
	}
}
