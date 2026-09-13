package main

import (
	"sync"
	"time"
)

const (
	maxSignalSubscriptionsPerUser = 10
	maxSignalRequestsPerMinute    = 60
)

type signalLimiter struct {
	mu            sync.Mutex
	subscriptions map[string]int
	requests      map[string][]time.Time
	now           func() time.Time
}

func newSignalLimiter() *signalLimiter {
	return &signalLimiter{subscriptions: map[string]int{}, requests: map[string][]time.Time{}, now: time.Now}
}

func (l *signalLimiter) acquireSubscription(userID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.subscriptions[userID] >= maxSignalSubscriptionsPerUser {
		return false
	}
	l.subscriptions[userID]++
	return true
}

func (l *signalLimiter) releaseSubscription(userID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.subscriptions[userID] <= 1 {
		delete(l.subscriptions, userID)
		return
	}
	l.subscriptions[userID]--
}

func (l *signalLimiter) allowRequest(userID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cutoff := now.Add(-time.Minute)
	requests := l.requests[userID]
	kept := requests[:0]
	for _, at := range requests {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= maxSignalRequestsPerMinute {
		l.requests[userID] = kept
		return false
	}
	l.requests[userID] = append(kept, now)
	return true
}
