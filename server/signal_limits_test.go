package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestSignalLimiterSubscriptionsArePerUserAndReleased(t *testing.T) {
	limiter := newSignalLimiter()
	for i := 0; i < maxSignalSubscriptionsPerUser; i++ {
		assert.True(t, limiter.acquireSubscription("user-1"))
	}
	assert.False(t, limiter.acquireSubscription("user-1"))
	assert.True(t, limiter.acquireSubscription("user-2"))
	limiter.releaseSubscription("user-1")
	assert.True(t, limiter.acquireSubscription("user-1"))
}

func TestSignalLimiterRateLimitExpiresPerUser(t *testing.T) {
	now := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	limiter := newSignalLimiter()
	limiter.now = func() time.Time { return now }
	for i := 0; i < maxSignalRequestsPerMinute; i++ {
		assert.True(t, limiter.allowRequest("user-1"))
	}
	assert.False(t, limiter.allowRequest("user-1"))
	assert.True(t, limiter.allowRequest("user-2"))
	now = now.Add(time.Minute + time.Nanosecond)
	assert.True(t, limiter.allowRequest("user-1"))
}
